import { randomUUID } from 'crypto';
import { Op, Transaction } from 'sequelize';
import User from '@/models/auth/User.js';
import UserTufStellarAdminGrant from '@/models/billing/UserTufStellarAdminGrant.js';
import UserTufStellarEntitlementSegment from '@/models/billing/UserTufStellarEntitlementSegment.js';
import { isTufStellarMonths } from '@/server/services/billing/tufStellarProductCatalog.js';
import { loadOrCreateUserTufStellarBilling } from '@/server/services/billing/userTufStellarBillingSupport.js';
import {
  appendAdminGrantSegment,
  recomputeMaterializedExpiry,
  type AdminGrantDurationKind,
} from '@/server/services/billing/tufStellarEntitlementSegments.js';
import {
  attachAdminGrantIdToBillingEvent,
  createAdminGrantBillingEvent,
  markAdminGrantBillingEventRetracted,
} from '@/server/services/billing/tufStellarAdminGrantBillingEvent.js';
import { CacheInvalidation } from '@/server/middleware/cache.js';
import ElasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';

export type { AdminGrantDurationKind };

const sequelize = UserTufStellarAdminGrant.sequelize!;

const ADMIN_GRANT_DAYS_MIN = 1;
const ADMIN_GRANT_DAYS_MAX = 365;

export class TufStellarAdminGrantError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TufStellarAdminGrantError';
  }
}

export function validateAdminGrantDuration(
  durationKind: AdminGrantDurationKind,
  durationValue: number,
): void {
  if (!Number.isInteger(durationValue) || durationValue <= 0) {
    throw new TufStellarAdminGrantError('INVALID_DURATION', 'Duration must be a positive integer.');
  }
  if (durationKind === 'months') {
    if (!isTufStellarMonths(durationValue)) {
      throw new TufStellarAdminGrantError(
        'INVALID_DURATION',
        'Months must be one of the allowed catalog terms.',
      );
    }
    return;
  }
  if (durationKind === 'days') {
    if (durationValue < ADMIN_GRANT_DAYS_MIN || durationValue > ADMIN_GRANT_DAYS_MAX) {
      throw new TufStellarAdminGrantError(
        'INVALID_DURATION',
        `Days must be between ${ADMIN_GRANT_DAYS_MIN} and ${ADMIN_GRANT_DAYS_MAX}.`,
      );
    }
    return;
  }
  throw new TufStellarAdminGrantError('INVALID_DURATION', 'Invalid duration kind.');
}

function sanitizeNote(note: unknown): string | null {
  if (note == null) return null;
  const trimmed = String(note).trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, 255);
}

async function refreshBeneficiaryCaches(beneficiary: User): Promise<void> {
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
}

export interface AdminGrantListRow {
  id: number;
  grantedByUserId: string;
  grantedByUsername: string | null;
  grantedByNickname: string | null;
  beneficiaryUserId: string;
  beneficiaryUsername: string | null;
  beneficiaryNickname: string | null;
  durationKind: AdminGrantDurationKind;
  durationValue: number;
  startsAt: string;
  endsAt: string;
  note: string | null;
  status: 'active' | 'retracted';
  isExpired: boolean;
  retractedByUserId: string | null;
  retractedByUsername: string | null;
  retractedByNickname: string | null;
  retractedAt: string | null;
  createdAt: string;
}

function mapGrantRow(
  grant: UserTufStellarAdminGrant & {
    grantedBy?: User | null;
    beneficiary?: User | null;
    retractedBy?: User | null;
  },
): AdminGrantListRow {
  const endsMs = new Date(grant.endsAt).getTime();
  const isExpired = Number.isFinite(endsMs) && endsMs <= Date.now();
  return {
    id: grant.id,
    grantedByUserId: grant.grantedByUserId,
    grantedByUsername: grant.grantedBy?.username ?? null,
    grantedByNickname: grant.grantedBy?.nickname ?? null,
    beneficiaryUserId: grant.beneficiaryUserId,
    beneficiaryUsername: grant.beneficiary?.username ?? null,
    beneficiaryNickname: grant.beneficiary?.nickname ?? null,
    durationKind: grant.durationKind,
    durationValue: grant.durationValue,
    startsAt: grant.startsAt.toISOString(),
    endsAt: grant.endsAt.toISOString(),
    note: grant.note ?? null,
    status: grant.status,
    isExpired,
    retractedByUserId: grant.retractedByUserId ?? null,
    retractedByUsername: grant.retractedBy?.username ?? null,
    retractedByNickname: grant.retractedBy?.nickname ?? null,
    retractedAt: grant.retractedAt ? grant.retractedAt.toISOString() : null,
    createdAt: grant.createdAt.toISOString(),
  };
}

export async function grantAccess(params: {
  grantedByUserId: string;
  beneficiaryUserId: string;
  durationKind: AdminGrantDurationKind;
  durationValue: number;
  note?: string | null;
}): Promise<AdminGrantListRow> {
  const { grantedByUserId, beneficiaryUserId, durationKind, durationValue } = params;
  validateAdminGrantDuration(durationKind, durationValue);

  const beneficiary = await User.findByPk(beneficiaryUserId, {
    attributes: ['id', 'username', 'status', 'playerId'],
  });
  if (!beneficiary) {
    throw new TufStellarAdminGrantError('BENEFICIARY_NOT_FOUND', 'Beneficiary user not found.');
  }
  if (beneficiary.status === 'banned' || beneficiary.status === 'suspended') {
    throw new TufStellarAdminGrantError('BENEFICIARY_BLOCKED', 'That account cannot receive grants.');
  }

  const note = sanitizeNote(params.note);
  const grantUuid = randomUUID();
  const billingIdempotencyKey = `admin-grant-billing:${grantUuid}`;
  const segmentIdempotencyKey = `admin-grant-seg:${grantUuid}`;

  const grant = await sequelize.transaction(async (t: Transaction) => {
    await loadOrCreateUserTufStellarBilling(beneficiaryUserId);
    const billingEvent = await createAdminGrantBillingEvent({
      grantedByUserId,
      beneficiaryUserId,
      durationKind,
      durationValue,
      note,
      idempotencyKey: billingIdempotencyKey,
      transaction: t,
    });
    const { segmentId, startsAt, endsAt } = await appendAdminGrantSegment({
      userId: beneficiaryUserId,
      durationKind,
      durationValue,
      idempotencyKey: segmentIdempotencyKey,
      billingEventId: billingEvent.id,
      transaction: t,
    });

    const grantRow = await UserTufStellarAdminGrant.create(
      {
        grantedByUserId,
        beneficiaryUserId,
        durationKind,
        durationValue,
        startsAt,
        endsAt,
        segmentId,
        note,
        status: 'active',
      },
      { transaction: t },
    );

    await attachAdminGrantIdToBillingEvent(billingEvent.id, grantRow.id, t);
    return grantRow;
  });

  await refreshBeneficiaryCaches(beneficiary);

  const loaded = await UserTufStellarAdminGrant.findByPk(grant.id, {
    include: [
      { model: User, as: 'grantedBy', attributes: ['id', 'username', 'nickname'] },
      { model: User, as: 'beneficiary', attributes: ['id', 'username', 'nickname'] },
      { model: User, as: 'retractedBy', attributes: ['id', 'username', 'nickname'], required: false },
    ],
  });
  if (!loaded) {
    throw new TufStellarAdminGrantError('SERVER_ERROR', 'Grant was created but could not be loaded.');
  }
  return mapGrantRow(loaded);
}

export async function retractGrant(params: {
  grantId: number;
  retractedByUserId: string;
}): Promise<AdminGrantListRow> {
  const { grantId, retractedByUserId } = params;

  let beneficiaryUserId: string | null = null;

  await sequelize.transaction(async (t: Transaction) => {
    const grant = await UserTufStellarAdminGrant.findByPk(grantId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!grant) {
      throw new TufStellarAdminGrantError('GRANT_NOT_FOUND', 'Grant not found.');
    }
    if (grant.status === 'retracted') {
      throw new TufStellarAdminGrantError('GRANT_ALREADY_RETRACTED', 'Grant has already been retracted.');
    }

    beneficiaryUserId = grant.beneficiaryUserId;

    let billingEventId: number | null = null;
    if (grant.segmentId != null) {
      const segment = await UserTufStellarEntitlementSegment.findByPk(grant.segmentId, { transaction: t });
      billingEventId = segment?.billingEventId ?? null;
      await UserTufStellarEntitlementSegment.destroy({
        where: { id: grant.segmentId },
        transaction: t,
      });
      await recomputeMaterializedExpiry(grant.beneficiaryUserId, t);
    }

    if (billingEventId != null) {
      await markAdminGrantBillingEventRetracted({
        billingEventId,
        retractedByUserId,
        transaction: t,
      });
    }

    await grant.update(
      {
        status: 'retracted',
        retractedByUserId,
        retractedAt: new Date(),
        segmentId: null,
      },
      { transaction: t },
    );
  });

  if (beneficiaryUserId) {
    const beneficiary = await User.findByPk(beneficiaryUserId, { attributes: ['id', 'playerId'] });
    if (beneficiary) await refreshBeneficiaryCaches(beneficiary);
  }

  const loaded = await UserTufStellarAdminGrant.findByPk(grantId, {
    include: [
      { model: User, as: 'grantedBy', attributes: ['id', 'username', 'nickname'] },
      { model: User, as: 'beneficiary', attributes: ['id', 'username', 'nickname'] },
      { model: User, as: 'retractedBy', attributes: ['id', 'username', 'nickname'], required: false },
    ],
  });
  if (!loaded) {
    throw new TufStellarAdminGrantError('SERVER_ERROR', 'Grant was retracted but could not be loaded.');
  }
  return mapGrantRow(loaded);
}

export async function listGrants(params: {
  q?: string;
  expired?: boolean;
  page?: number;
  limit?: number;
}): Promise<{ grants: AdminGrantListRow[]; total: number; page: number; limit: number }> {
  const page = Math.max(1, params.page ?? 1);
  const limit = Math.min(100, Math.max(1, params.limit ?? 25));
  const offset = (page - 1) * limit;
  const now = new Date();

  const where: Record<string, unknown> = {};
  if (params.expired === true) {
    where.endsAt = { [Op.lt]: now };
  } else if (params.expired === false) {
    where.endsAt = { [Op.gte]: now };
  }

  const q = typeof params.q === 'string' ? params.q.trim() : '';
  const userIncludeBase = {
    model: User,
    attributes: ['id', 'username', 'nickname'],
    required: false,
  };

  let grantIds: number[] | null = null;
  if (q.length > 0) {
    const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
    const matchingUsers = await User.findAll({
      where: {
        [Op.or]: [{ username: { [Op.like]: like } }, { nickname: { [Op.like]: like } }],
      },
      attributes: ['id'],
      limit: 200,
    });
    const userIds = matchingUsers.map((u) => u.id);
    if (userIds.length === 0) {
      return { grants: [], total: 0, page, limit };
    }
    const idRows = await UserTufStellarAdminGrant.findAll({
      where: {
        ...where,
        [Op.or]: [
          { grantedByUserId: { [Op.in]: userIds } },
          { beneficiaryUserId: { [Op.in]: userIds } },
          { retractedByUserId: { [Op.in]: userIds } },
        ],
      },
      attributes: ['id'],
      order: [['createdAt', 'DESC']],
    });
    grantIds = idRows.map((r) => r.id);
    if (grantIds.length === 0) {
      return { grants: [], total: 0, page, limit };
    }
  }

  const listWhere = grantIds != null ? { ...where, id: { [Op.in]: grantIds } } : where;

  const total = await UserTufStellarAdminGrant.count({ where: listWhere });

  const rows = await UserTufStellarAdminGrant.findAll({
    where: listWhere,
    include: [
      { ...userIncludeBase, as: 'grantedBy' },
      { ...userIncludeBase, as: 'beneficiary' },
      { ...userIncludeBase, as: 'retractedBy' },
    ],
    order: [['createdAt', 'DESC']],
    offset,
    limit,
  });

  return {
    grants: rows.map((row) => mapGrantRow(row)),
    total,
    page,
    limit,
  };
}
