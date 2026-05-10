import { Op, Transaction, UniqueConstraintError } from 'sequelize';
import UserTufStellarEntitlementSegment from '@/models/billing/UserTufStellarEntitlementSegment.js';
import UserTufStellarBilling from '@/models/billing/UserTufStellarBilling.js';
import { addCalendarMonthsUtc } from '@/misc/utils/time/addCalendarMonthsUtc.js';

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

async function maxGiftEndsAtMs(userId: string, transaction?: Transaction): Promise<number | null> {
  const opts = transaction ? { transaction } : {};
  const maxEnd = await UserTufStellarEntitlementSegment.max('endsAt', {
    where: { userId, kind: 'gift' },
    ...opts,
  });
  if (maxEnd == null || maxEnd === '') return null;
  const ms = new Date(maxEnd as Date | string).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Subscriptions are deferred behind gifts: after a new gift ending at `giftEndMs`, push any subscription windows
 * that still overlap the gift-backed window so they chain afterward (same duration `months` each).
 */
async function shiftSubscriptionsAfterGiftEnd(
  userId: string,
  giftEndMs: number,
  transaction: Transaction,
): Promise<void> {
  const subs = await UserTufStellarEntitlementSegment.findAll({
    where: { userId, kind: 'subscription' },
    order: [
      ['startsAt', 'ASC'],
      ['id', 'ASC'],
    ],
    transaction,
  });
  let cursorMs = giftEndMs;
  for (const sub of subs) {
    const ss = sub.startsAt.getTime();
    const se = sub.endsAt.getTime();
    if (ss >= cursorMs) {
      cursorMs = Math.max(cursorMs, se);
      continue;
    }
    const startsAt = new Date(cursorMs);
    const endsAt = addCalendarMonthsUtc(startsAt, sub.months);
    await sub.update({ startsAt, endsAt }, { transaction });
    cursorMs = endsAt.getTime();
  }
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
 * When Xsolla reports subscription end: remove segments that start at or after the cap; shorten segments that span past it.
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

/** Fallback when plan months cannot be resolved: extend materialized expiry with Xsolla next-charge ceiling (legacy merge). */
export async function mergeMaterializedExpiryWithWebhookNextCharge(
  userId: string,
  nextCharge: Date,
  transaction?: Transaction,
): Promise<void> {
  const opts = transaction ? { transaction } : {};
  const maxMs = await maxSegmentEndsAtMs(userId, transaction);
  const mergedMs = Math.max(maxMs ?? 0, nextCharge.getTime());
  await UserTufStellarBilling.update(
    { tufStellarSubscriptionExpiresAt: new Date(mergedMs) },
    { where: { userId }, ...opts },
  );
}

/** Gifts stack on the gift chain only; subscriptions are pushed back so gift time is always consumed first. */
export async function appendGiftSegment(params: {
  userId: string;
  months: number;
  idempotencyKey: string;
  xsollaTransactionId?: number | null;
  xsollaSubscriptionId?: number | null;
  billingEventId?: number | null;
  transaction?: Transaction;
}): Promise<{ inserted: boolean; endsAt: Date }> {
  const { userId, months, idempotencyKey, transaction } = params;

  const run = async (t: Transaction): Promise<{ inserted: boolean; endsAt: Date }> => {
    const nowMs = Date.now();
    const giftTailMs = await maxGiftEndsAtMs(userId, t);
    const startMs = Math.max(nowMs, giftTailMs ?? 0);
    const startsAt = new Date(startMs);
    const endsAt = addCalendarMonthsUtc(startsAt, months);
    let inserted = true;
    try {
      await UserTufStellarEntitlementSegment.create(
        {
          userId,
          kind: 'gift',
          months,
          startsAt,
          endsAt,
          idempotencyKey,
          xsollaTransactionId: params.xsollaTransactionId ?? null,
          xsollaSubscriptionId: params.xsollaSubscriptionId ?? null,
          billingEventId: params.billingEventId ?? null,
        },
        { transaction: t },
      );
    } catch (e: unknown) {
      if (e instanceof UniqueConstraintError) {
        inserted = false;
      } else {
        throw e;
      }
    }
    if (inserted) {
      await shiftSubscriptionsAfterGiftEnd(userId, endsAt.getTime(), t);
    }
    await recomputeMaterializedExpiry(userId, t);
    const maxMs = await maxSegmentEndsAtMs(userId, t);
    return { inserted, endsAt: maxMs != null ? new Date(maxMs) : endsAt };
  };

  if (transaction) {
    return run(transaction);
  }
  return sequelize.transaction(run);
}

/**
 * Subscription grants behave like one-time stacks placed after **all** existing entitlement (gifts + subs),
 * i.e. deferred behind gift-backed time already on the timeline.
 */
export async function appendSubscriptionSegment(params: {
  userId: string;
  months: number;
  idempotencyKey: string;
  xsollaTransactionId?: number | null;
  xsollaSubscriptionId?: number | null;
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
          kind: 'subscription',
          months,
          startsAt,
          endsAt,
          idempotencyKey,
          xsollaTransactionId: params.xsollaTransactionId ?? null,
          xsollaSubscriptionId: params.xsollaSubscriptionId ?? null,
          billingEventId: params.billingEventId ?? null,
        },
        { transaction: t },
      );
      await recomputeMaterializedExpiry(userId, t);
      return { inserted: true, endsAt };
    } catch (e: unknown) {
      if (e instanceof UniqueConstraintError) {
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
