import {Op} from 'sequelize';
import PushSubscription from '@/models/notifications/PushSubscription.js';
import {normalizePushLocale} from './copy/pushCopy.js';
import {
  normalizePushDeviceKey,
  parsePushDeviceProfile,
  planPushSubscriptionUpsert,
  type PushUpsertIntent,
} from './pushDevice.js';

export interface BrowserPushSubscriptionInput {
  endpoint: string;
  expirationTime?: number | null;
  keys?: {p256dh?: string; auth?: string};
  locale?: string;
  userAgent?: string | null;
  deviceKey?: string | null;
}

export interface PushDeviceSummary {
  id: number;
  browser: string;
  os: string;
  isCurrent: boolean;
  createdAt: Date;
  lastSeenAt: Date;
}

export interface PushSubscriptionUpsertResult {
  attached: boolean;
  revoked: boolean;
  device: PushDeviceSummary | null;
}

function expirationDate(value: number | null | undefined): Date | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return new Date(value);
}

function toSummary(row: PushSubscription, currentDeviceKey: string | null): PushDeviceSummary {
  const profile = parsePushDeviceProfile(row.userAgent);
  return {
    id: row.id,
    browser: profile.browser,
    os: profile.os,
    isCurrent: Boolean(currentDeviceKey && row.deviceKey === currentDeviceKey && !row.revokedAt),
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
  };
}

export async function upsertPushSubscription(
  userId: string,
  input: BrowserPushSubscriptionInput,
  intent: PushUpsertIntent = 'attach',
): Promise<PushSubscriptionUpsertResult> {
  const endpoint = String(input.endpoint ?? '').trim();
  const p256dh = String(input.keys?.p256dh ?? '').trim();
  const auth = String(input.keys?.auth ?? '').trim();
  if (!endpoint || !p256dh || !auth) {
    throw new Error('Invalid push subscription');
  }
  if (endpoint.length > 512) {
    throw new Error('Push endpoint too long');
  }
  const deviceKey = normalizePushDeviceKey(input.deviceKey);
  const locale = normalizePushLocale(input.locale);
  const now = new Date();
  const matches = await PushSubscription.findAll({
    where: {
      [Op.or]: [
        {endpoint},
        ...(deviceKey ? [{userId, deviceKey}] : []),
      ],
    },
  });
  const plan = planPushSubscriptionUpsert({
    intent,
    userId,
    endpoint,
    deviceKey,
    rows: matches.map((row) => ({
      id: row.id,
      userId: row.userId,
      endpoint: row.endpoint,
      deviceKey: row.deviceKey,
      revoked: Boolean(row.revokedAt),
    })),
  });

  if (plan.action === 'missing') {
    return {attached: false, revoked: false, device: null};
  }
  if (plan.action === 'revoked') {
    return {attached: false, revoked: true, device: null};
  }

  const sequelize = PushSubscription.sequelize;
  if (!sequelize) throw new Error('Push subscriptions database is unavailable');

  const saved = await sequelize.transaction(async (transaction) => {
    if (plan.action === 'update' && plan.deleteIds.length) {
      await PushSubscription.destroy({where: {id: plan.deleteIds}, transaction});
    }

    const fields = {
      userId,
      endpoint,
      p256dh,
      auth,
      expirationTime: expirationDate(input.expirationTime),
      locale,
      lastSeenAt: now,
      ...(intent === 'attach' ? {revokedAt: null} : {}),
    };

    if (plan.action === 'create') {
      return PushSubscription.create(
        {
          ...fields,
          userAgent: input.userAgent ?? null,
          deviceKey,
          revokedAt: null,
          createdAt: now,
        },
        {transaction},
      );
    }

    const existing = await PushSubscription.findByPk(plan.id, {transaction});
    if (!existing) {
      return PushSubscription.create(
        {
          ...fields,
          userAgent: input.userAgent ?? null,
          deviceKey,
          revokedAt: null,
          createdAt: now,
        },
        {transaction},
      );
    }
    await existing.update(
      {
        ...fields,
        userAgent: input.userAgent ?? existing.userAgent,
        deviceKey: deviceKey ?? existing.deviceKey,
      },
      {transaction},
    );
    return existing;
  });

  return {attached: true, revoked: false, device: toSummary(saved, deviceKey)};
}

export async function deletePushSubscription(
  userId: string,
  endpoint: string,
): Promise<boolean> {
  const trimmed = String(endpoint ?? '').trim();
  if (!trimmed) return false;
  const row = await PushSubscription.findOne({where: {userId, endpoint: trimmed}});
  if (!row) return false;
  if (!row.revokedAt) await row.update({revokedAt: new Date()});
  return true;
}

export async function revokePushSubscriptionById(
  userId: string,
  id: number,
): Promise<boolean> {
  const row = await PushSubscription.findOne({where: {id, userId}});
  if (!row) return false;
  if (!row.revokedAt) await row.update({revokedAt: new Date()});
  return true;
}

export async function listPushDevices(
  userId: string,
  currentDeviceKey: string | null,
): Promise<PushDeviceSummary[]> {
  const rows = await PushSubscription.findAll({
    where: {userId, revokedAt: null},
    order: [['lastSeenAt', 'DESC'], ['id', 'DESC']],
  });
  return rows.map((row) => toSummary(row, currentDeviceKey));
}

export async function listPushSubscriptions(userId: string): Promise<PushSubscription[]> {
  return PushSubscription.findAll({where: {userId, revokedAt: null}});
}
