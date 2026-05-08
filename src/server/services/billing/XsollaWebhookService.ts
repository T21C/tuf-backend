import crypto from 'crypto';
import type { CreationAttributes } from 'sequelize';
import BillingEvent from '@/models/billing/BillingEvent.js';
import { logger } from '@/server/services/core/LoggerService.js';

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
   * Minimal processing stub. For now, this just marks the event processed.
   * Next step will be mapping subscription webhooks -> `users.tufStellarSubscriptionExpiresAt`.
   */
  static async processEvent(event: BillingEvent): Promise<void> {
    try {
      await this.markProcessed(event.id);
    } catch (e) {
      logger.error('[Xsolla] Failed to process billing event', { eventId: event.id, err: e });
      await this.markFailed(event.id, 'PROCESSING_ERROR', 'Failed to process billing event');
      throw e;
    }
  }
}
