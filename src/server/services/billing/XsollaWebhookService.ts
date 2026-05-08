import crypto from 'crypto';
import type { CreationAttributes } from 'sequelize';
import BillingEvent from '@/models/billing/BillingEvent.js';
import User from '@/models/auth/User.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { permissionFlags } from '@/config/constants.js';
import { setUserPermissionAndSave } from '@/misc/utils/auth/permissionUtils.js';
import { syncTufStellarPermissionFromExpiry } from '@/misc/utils/subscriptions/tufStellarSubscription.js';
import {
  classifyExternalKind,
  getBillingLifecycleState,
  transitionBillingLifecycle,
} from '@/misc/utils/subscriptions/billingLifecycleTransition.js';
import { CacheInvalidation } from '@/server/middleware/cache.js';

export type XsollaNotificationType =
  | 'user_validation'
  | 'user_search'
  | 'payment'
  | 'refund'
  | 'partial_refund'
  | 'ps_declined'
  | 'afs_reject'
  | 'afs_black_list'
  | 'dispute'
  | 'order_paid'
  | 'order_canceled'
  | 'create_subscription'
  | 'update_subscription'
  | 'cancel_subscription'
  | 'non_renewal_subscription'
  | string;

export class XsollaWebhookService {
  static PROVIDER = 'xsolla';

  static computeSignature(rawBody: Buffer, secret: string): string {
    const h = crypto.createHash('sha1');
    h.update(rawBody);
    h.update(secret, 'utf8');
    return h.digest('hex').toLowerCase();
  }

  static verifySignature(rawBody: Buffer, secret: string, authorizationHeader: string | undefined | null): boolean {
    if (!authorizationHeader) return false;
    const m = authorizationHeader.match(/^Signature\s+([0-9a-fA-F]+)\s*$/);
    if (!m) return false;
    const received = m[1].toLowerCase();
    const computed = this.computeSignature(rawBody, secret);
    if (received.length !== computed.length) return false;
    return crypto.timingSafeEqual(Buffer.from(received, 'hex'), Buffer.from(computed, 'hex'));
  }

  static sha256Hex(rawBody: Buffer): string {
    return crypto.createHash('sha256').update(rawBody).digest('hex').toLowerCase();
  }

  /**
   * Derive a stable idempotency key from the payload fields Xsolla reliably repeats.
   * Preference order:
   * - transaction.id (payment/refund)
   * - purchase.subscription.subscription_id + eventType + date_next_charge/date_create
   * - purchase.order.id (combined store webhooks)
   * - fallback to raw-body sha256 (last resort; still dedupes exact duplicates)
   */
  static deriveIdempotencyKey(notificationType: XsollaNotificationType, payload: any, rawBodySha256: string): string {
    const txId = payload?.transaction?.id;
    if (txId != null && txId !== '') return `tx:${String(txId)}`;

    const subId = payload?.purchase?.subscription?.subscription_id ?? payload?.purchase?.subscription?.subscriptionId;
    if (subId != null && subId !== '') {
      const nextCharge = payload?.purchase?.subscription?.date_next_charge ?? payload?.purchase?.subscription?.dateNextCharge;
      const created = payload?.purchase?.subscription?.date_create ?? payload?.purchase?.subscription?.dateCreate;
      const t = nextCharge || created || '';
      return `sub:${String(subId)}:${notificationType}:${String(t)}`;
    }

    const orderId = payload?.purchase?.order?.id;
    if (orderId != null && orderId !== '') return `order:${String(orderId)}:${notificationType}`;

    return `body:${rawBodySha256}`;
  }

  static extractXsollaFields(payload: any): {
    userId: string | null;
    xsollaTransactionId: number | null;
    xsollaSubscriptionId: number | null;
    externalId: string | null;
  } {
    const userId = payload?.user?.id != null ? String(payload.user.id) : null;
    const xsollaTransactionId =
      payload?.transaction?.id != null && payload.transaction.id !== ''
        ? Number(payload.transaction.id)
        : null;
    const xsollaSubscriptionId =
      payload?.purchase?.subscription?.subscription_id != null && payload.purchase.subscription.subscription_id !== ''
        ? Number(payload.purchase.subscription.subscription_id)
        : null;
    const externalId =
      payload?.transaction?.external_id != null && payload.transaction.external_id !== ''
        ? String(payload.transaction.external_id)
        : null;
    return {
      userId,
      xsollaTransactionId: Number.isFinite(xsollaTransactionId) ? xsollaTransactionId : null,
      xsollaSubscriptionId: Number.isFinite(xsollaSubscriptionId) ? xsollaSubscriptionId : null,
      externalId,
    };
  }

  /**
   * Insert the event if it is new; returns null if already seen.
   */
  static async recordIfNew(params: {
    notificationType: XsollaNotificationType;
    body: any;
  }): Promise<BillingEvent | null> {
    const normalized = Buffer.from(JSON.stringify(params.body), 'utf8');
    const rawBodySha256 = this.sha256Hex(normalized);
    const idempotencyKey = this.deriveIdempotencyKey(params.notificationType, params.body, rawBodySha256);
    const extracted = this.extractXsollaFields(params.body);

    const createAttrs: CreationAttributes<BillingEvent> = {
      provider: this.PROVIDER,
      eventType: params.notificationType,
      idempotencyKey,
      status: 'received',
      rawBody: normalized.toString('utf8'),
      rawBodySha256,
      userId: extracted.userId,
      xsollaTransactionId: extracted.xsollaTransactionId,
      xsollaSubscriptionId: extracted.xsollaSubscriptionId,
      externalId: extracted.externalId,
      processedAt: null,
      failedAt: null,
      errorCode: null,
      errorMessage: null,
      createdAt: new Date(),
    };

    try {
      return await BillingEvent.create(createAttrs);
    } catch (e: any) {
      const name = e?.name || '';
      const msg = String(e?.message || '');
      if (name === 'SequelizeUniqueConstraintError' || msg.includes('uniq_billing_events_provider_idempotency')) {
        return null;
      }
      throw e;
    }
  }

  static async markProcessed(eventId: number): Promise<void> {
    await BillingEvent.update(
      { status: 'processed', processedAt: new Date(), failedAt: null, errorCode: null, errorMessage: null },
      { where: { id: eventId } },
    );
  }

  static async markFailed(eventId: number, code: string, message: string): Promise<void> {
    await BillingEvent.update(
      { status: 'failed', failedAt: new Date(), errorCode: code, errorMessage: message?.slice(0, 512) ?? null },
      { where: { id: eventId } },
    );
  }

  /**
   * Maps an Xsolla webhook into User-side state changes:
   * - payment / order_paid / create_subscription / update_subscription -> extend expiry, grant TUF_STELLAR
   * - cancel_subscription / non_renewal_subscription -> mark cancelledAt (period still served until expiresAt)
   * - refund / partial_refund / order_canceled -> revoke immediately if it matches the active sub/tx
   */
  static async processEvent(event: BillingEvent): Promise<void> {
    try {
      const payload = parseRawBody(event.rawBody);
      const userId = event.userId ?? (payload?.user?.id != null ? String(payload.user.id) : null);

      switch (event.eventType) {
        case 'payment':
        case 'order_paid':
        case 'create_subscription':
        case 'update_subscription': {
          if (userId) await applySubscriptionExtension(userId, event, payload);
          break;
        }
        case 'cancel_subscription':
        case 'non_renewal_subscription': {
          if (userId) await applySubscriptionCancelled(userId, event, payload);
          break;
        }
        case 'refund':
        case 'partial_refund':
        case 'order_canceled': {
          if (userId) await applySubscriptionRevoke(userId, event);
          break;
        }
        default:
          break;
      }

      await this.markProcessed(event.id);
    } catch (e) {
      logger.error('[Xsolla] Failed to process billing event', { eventId: event.id, err: e });
      await this.markFailed(event.id, 'PROCESSING_ERROR', e instanceof Error ? e.message : 'Failed to process billing event');
      throw e;
    }
  }
}

// ---------- helpers ----------

function parseRawBody(rawBody: string): any {
  try {
    return JSON.parse(rawBody);
  } catch {
    return {};
  }
}

function parseDate(input: unknown): Date | null {
  if (input == null || input === '') return null;
  const s = typeof input === 'string' || typeof input === 'number' ? input : String(input);
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d : null;
}

/** Resolve the period end (next charge) from the payload, falling back to a +30 day window. */
function resolveNextExpiry(payload: any): Date {
  const sub = payload?.purchase?.subscription;
  const next =
    parseDate(sub?.date_next_charge) ??
    parseDate(sub?.dateNextCharge) ??
    parseDate(sub?.expires_at) ??
    parseDate(sub?.expiresAt) ??
    parseDate(payload?.transaction?.payment_date);
  if (next && next.getTime() > Date.now()) return next;
  const fallback = new Date();
  fallback.setUTCDate(fallback.getUTCDate() + 30);
  return fallback;
}

function resolveExternalSubscriptionId(payload: any, event: BillingEvent): string | null {
  if (event.xsollaSubscriptionId != null) return String(event.xsollaSubscriptionId);
  const subId = payload?.purchase?.subscription?.subscription_id ?? payload?.purchase?.subscription?.subscriptionId;
  if (subId != null && subId !== '') return String(subId);
  if (event.externalId) return event.externalId;
  if (event.xsollaTransactionId != null) return `tx:${event.xsollaTransactionId}`;
  return null;
}

async function applySubscriptionExtension(userId: string, event: BillingEvent, payload: any): Promise<void> {
  const user = await User.findByPk(userId);
  if (!user) return;

  const nextExpiry = resolveNextExpiry(payload);
  const externalId = resolveExternalSubscriptionId(payload, event);
  const mergedExternal = externalId ?? user.tufStellarSubscriptionExternalId ?? null;
  const prevLifecycle = getBillingLifecycleState(user);
  const kind = classifyExternalKind(mergedExternal);
  const nextLifecycle = transitionBillingLifecycle(prevLifecycle, {
    type: 'webhook_subscription_extended',
    externalKind: kind,
  });

  await user.update({
    tufStellarSubscriptionExpiresAt: nextExpiry,
    tufStellarSubscriptionExternalId: mergedExternal,
    tufStellarSubscriptionCancelledAt: null,
    tufStellarBillingLifecycleState: nextLifecycle,
  });

  await setUserPermissionAndSave(user, permissionFlags.TUF_STELLAR, true);

  try {
    await CacheInvalidation.invalidateUser(user.id);
  } catch {
    /* best-effort */
  }
}

async function applySubscriptionCancelled(userId: string, event: BillingEvent, payload: any): Promise<void> {
  const user = await User.findByPk(userId);
  if (!user) return;

  const externalId = resolveExternalSubscriptionId(payload, event);
  const prevLifecycle = getBillingLifecycleState(user);
  const nextLifecycle = transitionBillingLifecycle(prevLifecycle, { type: 'webhook_subscription_cancelled' });

  await user.update({
    tufStellarSubscriptionCancelledAt: new Date(),
    tufStellarSubscriptionExternalId: externalId ?? user.tufStellarSubscriptionExternalId ?? null,
    tufStellarBillingLifecycleState: nextLifecycle,
  });

  try {
    await CacheInvalidation.invalidateUser(user.id);
  } catch {
    /* best-effort */
  }
}

async function applySubscriptionRevoke(userId: string, event: BillingEvent): Promise<void> {
  const user = await User.findByPk(userId);
  if (!user) return;

  const matchesSubscription =
    event.xsollaSubscriptionId != null &&
    user.tufStellarSubscriptionExternalId === String(event.xsollaSubscriptionId);
  const matchesTransaction =
    event.xsollaTransactionId != null &&
    user.tufStellarSubscriptionExternalId === `tx:${event.xsollaTransactionId}`;

  if (!matchesSubscription && !matchesTransaction) return;

  const prevLifecycle = getBillingLifecycleState(user);
  const nextLifecycle = transitionBillingLifecycle(prevLifecycle, { type: 'webhook_subscription_revoked' });

  await user.update({
    tufStellarSubscriptionExpiresAt: new Date(),
    tufStellarSubscriptionCancelledAt: new Date(),
    tufStellarBillingLifecycleState: nextLifecycle,
  });
  await syncTufStellarPermissionFromExpiry(user);

  try {
    await CacheInvalidation.invalidateUser(user.id);
  } catch {
    /* best-effort */
  }
}
