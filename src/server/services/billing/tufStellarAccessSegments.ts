import BillingEvent from '@/models/billing/BillingEvent.js';
import User from '@/models/auth/User.js';
import { loadSegmentsForUser } from '@/server/services/billing/tufStellarEntitlementSegments.js';
import {
  isAdminGrantBillingEvent,
  parseAdminGrantBillingEventPayload,
} from '@/server/services/billing/tufStellarAdminGrantBillingEvent.js';
import type { AdminGrantDurationKind } from '@/server/services/billing/tufStellarEntitlementSegments.js';

export type TufStellarAccessSegmentSource = 'self_purchase' | 'gift_received' | 'admin_grant' | 'unknown';

export interface TufStellarAccessSegmentGiftFrom {
  userId: string;
  username: string | null;
}

export interface TufStellarAccessSegmentDto {
  segmentId: number;
  months: number;
  startsAt: string;
  endsAt: string;
  remainingMs: number;
  source: TufStellarAccessSegmentSource;
  giftFrom: TufStellarAccessSegmentGiftFrom | null;
  grantFrom: TufStellarAccessSegmentGiftFrom | null;
  durationKind: AdminGrantDurationKind | null;
  durationValue: number | null;
}

function normUuid(v: string | null | undefined): string | null {
  if (v == null || v === '') return null;
  return String(v).trim().toLowerCase();
}

function classifySegmentSource(
  viewerId: string,
  event: BillingEvent | null | undefined,
): {
  source: TufStellarAccessSegmentSource;
  giftFrom: TufStellarAccessSegmentGiftFrom | null;
  grantFrom: TufStellarAccessSegmentGiftFrom | null;
  durationKind: AdminGrantDurationKind | null;
  durationValue: number | null;
} {
  const me = normUuid(viewerId);
  if (!event || !me) {
    return { source: 'unknown', giftFrom: null, grantFrom: null, durationKind: null, durationValue: null };
  }

  if (isAdminGrantBillingEvent(event)) {
    const payload = parseAdminGrantBillingEventPayload(event.rawBody);
    const benId = normUuid(event.beneficiaryUserId);
    const granterRaw = event.userId ? String(event.userId).trim() : '';
    const granterNorm = normUuid(granterRaw);

    if (benId === me) {
      const grantFrom =
        granterNorm && granterNorm !== me
          ? { userId: granterRaw || granterNorm, username: null }
          : null;
      return {
        source: 'admin_grant',
        giftFrom: null,
        grantFrom,
        durationKind: payload?.durationKind ?? null,
        durationValue: payload?.durationValue ?? null,
      };
    }

    return { source: 'unknown', giftFrom: null, grantFrom: null, durationKind: null, durationValue: null };
  }

  const purchaserRaw = event.userId ? String(event.userId).trim() : '';
  const purchaserNorm = normUuid(purchaserRaw);
  const benId = normUuid(event.beneficiaryUserId);

  if (benId && purchaserNorm && benId === me && purchaserNorm !== benId) {
    return {
      source: 'gift_received',
      giftFrom: {
        userId: purchaserRaw || purchaserNorm,
        username: null,
      },
      grantFrom: null,
      durationKind: null,
      durationValue: null,
    };
  }

  if (purchaserNorm === me || !benId || benId === purchaserNorm) {
    return { source: 'self_purchase', giftFrom: null, grantFrom: null, durationKind: null, durationValue: null };
  }

  return { source: 'unknown', giftFrom: null, grantFrom: null, durationKind: null, durationValue: null };
}

function remainingMsForSegment(startMs: number, endMs: number, nowMs: number): number {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return 0;
  const lo = Math.max(nowMs, startMs);
  const hi = endMs;
  return Math.max(0, hi - lo);
}

/**
 * Active entitlement chunks for the user (endsAt > now), FIFO order by startsAt.
 * Gift vs self inferred from linked BillingEvent when present.
 */
export async function buildTufStellarAccessSegmentsForUser(
  viewerUserId: string,
  nowMs: number = Date.now(),
): Promise<TufStellarAccessSegmentDto[]> {
  const rows = await loadSegmentsForUser(viewerUserId);
  const active = rows.filter((s) => new Date(s.endsAt).getTime() > nowMs);
  active.sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());

  const eventIds = [
    ...new Set(
      active.map((s) => s.billingEventId).filter((id): id is number => id != null && Number.isFinite(Number(id))),
    ),
  ];

  const events =
    eventIds.length === 0
      ? []
      : await BillingEvent.findAll({
          where: { id: eventIds },
        });

  const eventById = new Map<number, BillingEvent>();
  for (const e of events) {
    eventById.set(Number(e.id), e);
  }

  const counterpartyRawIds = [
    ...new Set(
      events
        .flatMap((e) => [e.userId, e.beneficiaryUserId])
        .filter((id): id is string => Boolean(id && String(id).trim())),
    ),
  ];

  const counterparties =
    counterpartyRawIds.length === 0
      ? []
      : await User.findAll({
          where: { id: counterpartyRawIds },
          attributes: ['id', 'username'],
        });

  const usernameById = new Map<string, string | null>();
  for (const u of counterparties) {
    usernameById.set(normUuid(u.id)!, u.username ?? null);
  }

  const out: TufStellarAccessSegmentDto[] = [];

  for (const s of active) {
    const startMs = new Date(s.startsAt).getTime();
    const endMs = new Date(s.endsAt).getTime();
    const rem = remainingMsForSegment(startMs, endMs, nowMs);

    const ev = s.billingEventId != null ? eventById.get(Number(s.billingEventId)) : undefined;
    const { source, giftFrom, grantFrom, durationKind, durationValue } = classifySegmentSource(
      viewerUserId,
      ev ?? null,
    );

    let resolvedGiftFrom = giftFrom;
    if (source === 'gift_received' && giftFrom?.userId) {
      resolvedGiftFrom = {
        userId: giftFrom.userId,
        username: usernameById.get(normUuid(giftFrom.userId)!) ?? null,
      };
    }

    let resolvedGrantFrom = grantFrom;
    if (source === 'admin_grant' && grantFrom?.userId) {
      resolvedGrantFrom = {
        userId: grantFrom.userId,
        username: usernameById.get(normUuid(grantFrom.userId)!) ?? null,
      };
    }

    out.push({
      segmentId: Number(s.id),
      months: Number(s.months),
      startsAt: new Date(s.startsAt).toISOString(),
      endsAt: new Date(s.endsAt).toISOString(),
      remainingMs: rem,
      source,
      giftFrom: resolvedGiftFrom,
      grantFrom: resolvedGrantFrom,
      durationKind,
      durationValue,
    });
  }

  return out;
}
