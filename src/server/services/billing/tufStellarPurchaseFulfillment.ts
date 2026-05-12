import BillingEvent from '@/models/billing/BillingEvent.js';
import { User } from '@/models/index.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { CacheInvalidation } from '@/server/middleware/cache.js';
import ElasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';
import { loadOrCreateUserTufStellarBilling } from '@/server/services/billing/userTufStellarBillingSupport.js';
import { appendPurchaseSegment } from '@/server/services/billing/tufStellarEntitlementSegments.js';

export async function clearPurchaserPendingCheckout(purchaser: User): Promise<void> {
  const billing = await loadOrCreateUserTufStellarBilling(purchaser.id);
  await billing.update({
    tufStellarPendingGiftBeneficiaryUserId: null,
    tufStellarPendingGiftMonths: null,
  });
}

export async function applyPurchaseEntitlementToBeneficiary(params: {
  beneficiaryUserId: string;
  months: number;
  purchaser: User;
  billingEvent: BillingEvent;
  idempotencyKeySuffix: string;
  stripePaymentIntentId: string | null;
  xsollaTransactionId?: number | null;
  xsollaSubscriptionId?: number | null;
  logPrefix: string;
}): Promise<void> {
  const {
    beneficiaryUserId,
    months,
    purchaser,
    billingEvent,
    idempotencyKeySuffix,
    stripePaymentIntentId,
    xsollaTransactionId,
    xsollaSubscriptionId,
    logPrefix,
  } = params;

  const beneficiary = await User.findByPk(beneficiaryUserId);
  if (!beneficiary) {
    logger.warn(`${logPrefix} Purchase entitlement skipped — beneficiary missing`, { beneficiaryUserId });
    return;
  }

  const benBilling = await loadOrCreateUserTufStellarBilling(beneficiary.id);
  const { endsAt: newExpiry, inserted } = await appendPurchaseSegment({
    userId: beneficiary.id,
    months,
    idempotencyKey: `seg:purchase:${idempotencyKeySuffix}`,
    xsollaTransactionId: xsollaTransactionId ?? null,
    xsollaSubscriptionId: xsollaSubscriptionId ?? null,
    stripePaymentIntentId,
    billingEventId: billingEvent.id,
  });

  await clearPurchaserPendingCheckout(purchaser);

  try {
    await CacheInvalidation.invalidateUser(beneficiary.id);
  } catch {
    /* best-effort */
  }

  if (beneficiary.playerId != null) {
    try {
      await ElasticsearchService.getInstance().reindexPlayers([beneficiary.playerId]);
    } catch {
      /* best-effort */
    }
  }

  await beneficiary.reload();
  await benBilling.reload();

  logger.info(`${logPrefix} Purchase entitlement applied`, {
    beneficiaryUserId,
    months,
    newExpiry,
    purchaserId: purchaser.id,
    segmentInserted: inserted,
  });
}
