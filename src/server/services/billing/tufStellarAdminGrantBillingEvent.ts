import { Transaction } from 'sequelize';
import BillingEvent from '@/models/billing/BillingEvent.js';
import type { AdminGrantDurationKind } from '@/server/services/billing/tufStellarEntitlementSegments.js';

export const ADMIN_GRANT_BILLING_PROVIDER = 'admin';
export const ADMIN_GRANT_BILLING_EVENT_TYPE = 'admin_grant';

export interface AdminGrantBillingEventPayload {
  type: typeof ADMIN_GRANT_BILLING_EVENT_TYPE;
  durationKind: AdminGrantDurationKind;
  durationValue: number;
  note?: string | null;
  adminGrantId?: number | null;
  retractedAt?: string | null;
  retractedByUserId?: string | null;
}

export function isAdminGrantBillingEvent(event: Pick<BillingEvent, 'provider' | 'eventType'>): boolean {
  return event.provider === ADMIN_GRANT_BILLING_PROVIDER && event.eventType === ADMIN_GRANT_BILLING_EVENT_TYPE;
}

export function parseAdminGrantBillingEventPayload(rawBody: string): AdminGrantBillingEventPayload | null {
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const p = parsed as Record<string, unknown>;
    if (p.type !== ADMIN_GRANT_BILLING_EVENT_TYPE) return null;
    const durationKind = p.durationKind;
    const durationValue = Number(p.durationValue);
    if (durationKind !== 'months' && durationKind !== 'days') return null;
    if (!Number.isFinite(durationValue) || durationValue <= 0) return null;
    return {
      type: ADMIN_GRANT_BILLING_EVENT_TYPE,
      durationKind,
      durationValue,
      note: p.note != null && String(p.note).trim() !== '' ? String(p.note).trim() : null,
      adminGrantId: p.adminGrantId != null && Number.isFinite(Number(p.adminGrantId)) ? Number(p.adminGrantId) : null,
      retractedAt: typeof p.retractedAt === 'string' ? p.retractedAt : null,
      retractedByUserId: typeof p.retractedByUserId === 'string' ? p.retractedByUserId : null,
    };
  } catch {
    return null;
  }
}

function buildAdminGrantRawBody(params: {
  durationKind: AdminGrantDurationKind;
  durationValue: number;
  note?: string | null;
  adminGrantId?: number | null;
  retractedAt?: string | null;
  retractedByUserId?: string | null;
}): string {
  const payload: AdminGrantBillingEventPayload = {
    type: ADMIN_GRANT_BILLING_EVENT_TYPE,
    durationKind: params.durationKind,
    durationValue: params.durationValue,
    note: params.note ?? null,
    adminGrantId: params.adminGrantId ?? null,
    retractedAt: params.retractedAt ?? null,
    retractedByUserId: params.retractedByUserId ?? null,
  };
  return JSON.stringify(payload);
}

export async function createAdminGrantBillingEvent(params: {
  grantedByUserId: string;
  beneficiaryUserId: string;
  durationKind: AdminGrantDurationKind;
  durationValue: number;
  note?: string | null;
  idempotencyKey: string;
  transaction?: Transaction;
}): Promise<BillingEvent> {
  const now = new Date();
  return BillingEvent.create(
    {
      provider: ADMIN_GRANT_BILLING_PROVIDER,
      eventType: ADMIN_GRANT_BILLING_EVENT_TYPE,
      idempotencyKey: params.idempotencyKey,
      status: 'processed',
      userId: params.grantedByUserId,
      beneficiaryUserId: params.beneficiaryUserId,
      rawBody: buildAdminGrantRawBody({
        durationKind: params.durationKind,
        durationValue: params.durationValue,
        note: params.note,
      }),
      processedAt: now,
    },
    { transaction: params.transaction },
  );
}

export async function attachAdminGrantIdToBillingEvent(
  billingEventId: number,
  adminGrantId: number,
  transaction?: Transaction,
): Promise<void> {
  const row = await BillingEvent.findByPk(billingEventId, { transaction });
  if (!row) return;
  const payload = parseAdminGrantBillingEventPayload(row.rawBody);
  if (!payload) return;
  await row.update(
    {
      rawBody: buildAdminGrantRawBody({
        ...payload,
        adminGrantId,
      }),
    },
    { transaction },
  );
}

export async function markAdminGrantBillingEventRetracted(params: {
  billingEventId: number;
  retractedByUserId: string;
  transaction?: Transaction;
}): Promise<void> {
  const row = await BillingEvent.findByPk(params.billingEventId, { transaction: params.transaction });
  if (!row || !isAdminGrantBillingEvent(row)) return;

  const payload = parseAdminGrantBillingEventPayload(row.rawBody);
  if (!payload) return;

  await row.update(
    {
      status: 'refunded',
      rawBody: buildAdminGrantRawBody({
        ...payload,
        retractedAt: new Date().toISOString(),
        retractedByUserId: params.retractedByUserId,
      }),
    },
    { transaction: params.transaction },
  );
}
