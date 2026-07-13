import { Op, Transaction } from 'sequelize';
import UserTufStellarEntitlementSegment from '@/models/billing/UserTufStellarEntitlementSegment.js';
import UserTufStellarBilling from '@/models/billing/UserTufStellarBilling.js';
import { addCalendarMonthsUtc } from '@/misc/utils/time/addCalendarMonthsUtc.js';
import { mapMysqlClientError } from '@/misc/utils/db/mysqlClientError.js';

const sequelize = UserTufStellarEntitlementSegment.sequelize!;

async function maxSegmentEndsAtMs(userId: string, transaction?: Transaction): Promise<number | null> {
  const opts = transaction ? { transaction } : {};
  const maxEnd = await UserTufStellarEntitlementSegment.max('endsAt', {
    where: { userId },
    ...opts,
  });
  if (maxEnd == null || maxEnd === '') return null;
  const ms = new Date(maxEnd as Date | string).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export async function loadSegmentsForUser(userId: string): Promise<UserTufStellarEntitlementSegment[]> {
  return UserTufStellarEntitlementSegment.findAll({
    where: { userId },
    order: [['startsAt', 'ASC']],
  });
}

export async function recomputeMaterializedExpiry(userId: string, transaction?: Transaction): Promise<void> {
  const opts = transaction ? { transaction } : {};
  const maxMs = await maxSegmentEndsAtMs(userId, transaction);
  await UserTufStellarBilling.update(
    { tufStellarSubscriptionExpiresAt: maxMs != null ? new Date(maxMs) : null },
    { where: { userId }, ...opts },
  );
}

export async function deleteAllSegmentsForUser(userId: string, transaction?: Transaction): Promise<void> {
  const opts = transaction ? { transaction } : {};
  await UserTufStellarEntitlementSegment.destroy({ where: { userId }, ...opts });
}

/**
 * When external systems report subscription end (legacy): remove segments starting at or after cap; shorten overlapping rows.
 */
export async function clampUserSegmentsToEndDate(
  userId: string,
  dateEnd: Date,
  transaction?: Transaction,
): Promise<void> {
  const opts = transaction ? { transaction } : {};
  await UserTufStellarEntitlementSegment.destroy({
    where: {
      userId,
      startsAt: { [Op.gte]: dateEnd },
    },
    ...opts,
  });
  await UserTufStellarEntitlementSegment.update(
    { endsAt: dateEnd },
    {
      where: {
        userId,
        endsAt: { [Op.gt]: dateEnd },
        startsAt: { [Op.lt]: dateEnd },
      },
      ...opts,
    },
  );
}

/** Stack calendar months after the latest segment end (or now). */
export async function appendPurchaseSegment(params: {
  userId: string;
  months: number;
  idempotencyKey: string;
  xsollaTransactionId?: number | null;
  xsollaSubscriptionId?: number | null;
  stripePaymentIntentId?: string | null;
  billingEventId?: number | null;
  transaction?: Transaction;
}): Promise<{ inserted: boolean; endsAt: Date }> {
  const { userId, months, idempotencyKey, transaction } = params;

  const run = async (t: Transaction): Promise<{ inserted: boolean; endsAt: Date }> => {
    const nowMs = Date.now();
    const globalTailMs = await maxSegmentEndsAtMs(userId, t);
    const startMs = Math.max(nowMs, globalTailMs ?? 0);
    const startsAt = new Date(startMs);
    const endsAt = addCalendarMonthsUtc(startsAt, months);
    try {
      await UserTufStellarEntitlementSegment.create(
        {
          userId,
          kind: 'purchase',
          months,
          startsAt,
          endsAt,
          idempotencyKey,
          xsollaTransactionId: params.xsollaTransactionId ?? null,
          xsollaSubscriptionId: params.xsollaSubscriptionId ?? null,
          stripePaymentIntentId: params.stripePaymentIntentId ?? null,
          billingEventId: params.billingEventId ?? null,
        },
        { transaction: t },
      );
      await recomputeMaterializedExpiry(userId, t);
      return { inserted: true, endsAt };
    } catch (e: unknown) {
      if (mapMysqlClientError(e)?.code === 'ER_DUP_ENTRY') {
        await recomputeMaterializedExpiry(userId, t);
        const maxMs = await maxSegmentEndsAtMs(userId, t);
        return { inserted: false, endsAt: maxMs != null ? new Date(maxMs) : endsAt };
      }
      throw e;
    }
  };

  if (transaction) {
    return run(transaction);
  }
  return sequelize.transaction(run);
}

export type AdminGrantDurationKind = 'months' | 'days';

/** Stack admin-granted access after the latest segment end (or now). */
export async function appendAdminGrantSegment(params: {
  userId: string;
  durationKind: AdminGrantDurationKind;
  durationValue: number;
  idempotencyKey: string;
  billingEventId?: number | null;
  transaction?: Transaction;
}): Promise<{ inserted: boolean; segmentId: number; startsAt: Date; endsAt: Date }> {
  const { userId, durationKind, durationValue, idempotencyKey, billingEventId, transaction } = params;

  const run = async (t: Transaction): Promise<{ inserted: boolean; segmentId: number; startsAt: Date; endsAt: Date }> => {
    const nowMs = Date.now();
    const globalTailMs = await maxSegmentEndsAtMs(userId, t);
    const startMs = Math.max(nowMs, globalTailMs ?? 0);
    const startsAt = new Date(startMs);
    const endsAt =
      durationKind === 'months'
        ? addCalendarMonthsUtc(startsAt, durationValue)
        : new Date(startMs + durationValue * 86_400_000);
    const monthsStored = durationKind === 'months' ? durationValue : 0;

    try {
      const segment = await UserTufStellarEntitlementSegment.create(
        {
          userId,
          kind: 'admin_grant',
          months: monthsStored,
          startsAt,
          endsAt,
          idempotencyKey,
          xsollaTransactionId: null,
          xsollaSubscriptionId: null,
          stripePaymentIntentId: null,
          billingEventId: billingEventId ?? null,
        },
        { transaction: t },
      );
      await recomputeMaterializedExpiry(userId, t);
      return { inserted: true, segmentId: segment.id, startsAt, endsAt };
    } catch (e: unknown) {
      if (mapMysqlClientError(e)?.code === 'ER_DUP_ENTRY') {
        await recomputeMaterializedExpiry(userId, t);
        const existing = await UserTufStellarEntitlementSegment.findOne({
          where: { idempotencyKey },
          transaction: t,
        });
        const maxMs = await maxSegmentEndsAtMs(userId, t);
        return {
          inserted: false,
          segmentId: existing?.id ?? 0,
          startsAt: existing?.startsAt ?? startsAt,
          endsAt: existing?.endsAt ?? (maxMs != null ? new Date(maxMs) : endsAt),
        };
      }
      throw e;
    }
  };

  if (transaction) {
    return run(transaction);
  }
  return sequelize.transaction(run);
}

/** Remove segments paid for by a given Xsolla transaction (refund / order canceled). Returns distinct user ids touched. */
export async function revokePurchaseSegmentsByXsollaTransactionId(
  xsollaTransactionId: number,
  transaction?: Transaction,
): Promise<string[]> {
  const opts = transaction ? { transaction } : {};
  const rows = await UserTufStellarEntitlementSegment.findAll({
    where: { xsollaTransactionId },
    ...opts,
  });
  if (rows.length === 0) return [];

  const userIds = [...new Set(rows.map((r) => r.userId))];
  await UserTufStellarEntitlementSegment.destroy({
    where: { xsollaTransactionId },
    ...opts,
  });
  for (const uid of userIds) {
    await recomputeMaterializedExpiry(uid, transaction);
  }
  return userIds;
}

/** Remove segments tied to a Stripe PaymentIntent (refund). Returns distinct user ids touched. */
export async function revokePurchaseSegmentsByStripePaymentIntentId(
  stripePaymentIntentId: string,
  transaction?: Transaction,
): Promise<string[]> {
  const id = String(stripePaymentIntentId).trim();
  if (!id) return [];
  const opts = transaction ? { transaction } : {};
  const rows = await UserTufStellarEntitlementSegment.findAll({
    where: { stripePaymentIntentId: id },
    ...opts,
  });
  if (rows.length === 0) return [];

  const userIds = [...new Set(rows.map((r) => r.userId))];
  await UserTufStellarEntitlementSegment.destroy({
    where: { stripePaymentIntentId: id },
    ...opts,
  });
  for (const uid of userIds) {
    await recomputeMaterializedExpiry(uid, transaction);
  }
  return userIds;
}
