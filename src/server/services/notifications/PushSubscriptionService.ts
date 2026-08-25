import PushSubscription from '@/models/notifications/PushSubscription.js';
import {normalizePushLocale} from './copy/pushCopy.js';

export interface BrowserPushSubscriptionInput {
  endpoint: string;
  expirationTime?: number | null;
  keys?: {p256dh?: string; auth?: string};
  locale?: string;
  userAgent?: string | null;
}

function expirationDate(value: number | null | undefined): Date | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return new Date(value);
}

export async function upsertPushSubscription(
  userId: string,
  input: BrowserPushSubscriptionInput,
): Promise<PushSubscription> {
  const endpoint = String(input.endpoint ?? '').trim();
  const p256dh = String(input.keys?.p256dh ?? '').trim();
  const auth = String(input.keys?.auth ?? '').trim();
  if (!endpoint || !p256dh || !auth) {
    throw new Error('Invalid push subscription');
  }
  if (endpoint.length > 512) {
    throw new Error('Push endpoint too long');
  }
  const locale = normalizePushLocale(input.locale);
  const now = new Date();
  const existing = await PushSubscription.findOne({where: {endpoint}});
  if (existing) {
    await existing.update({
      userId,
      p256dh,
      auth,
      expirationTime: expirationDate(input.expirationTime),
      userAgent: input.userAgent ?? existing.userAgent,
      locale,
      lastSeenAt: now,
    });
    return existing;
  }
  return PushSubscription.create({
    userId,
    endpoint,
    p256dh,
    auth,
    expirationTime: expirationDate(input.expirationTime),
    userAgent: input.userAgent ?? null,
    locale,
    createdAt: now,
    lastSeenAt: now,
  });
}

export async function deletePushSubscription(
  userId: string,
  endpoint: string,
): Promise<boolean> {
  const trimmed = String(endpoint ?? '').trim();
  if (!trimmed) return false;
  const count = await PushSubscription.destroy({where: {userId, endpoint: trimmed}});
  return count > 0;
}

export async function listPushSubscriptions(userId: string): Promise<PushSubscription[]> {
  return PushSubscription.findAll({where: {userId}});
}
