export type PushUpsertIntent = 'attach' | 'refresh';

export type PushBrowserName = 'Edge' | 'Opera' | 'Chrome' | 'Firefox' | 'Safari' | 'Browser';

export type PushOsName = 'Windows' | 'Android' | 'iOS' | 'macOS' | 'Linux' | '';

export interface PushSubscriptionSnapshot {
  id: number;
  userId: string;
  endpoint: string;
  deviceKey: string | null;
  revoked: boolean;
}

export type PushUpsertPlan =
  | {action: 'missing'}
  | {action: 'revoked'}
  | {action: 'create'}
  | {action: 'update'; id: number; deleteIds: number[]};

const DEVICE_KEY_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizePushDeviceKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (!DEVICE_KEY_RE.test(trimmed)) return null;
  return trimmed;
}

export function parsePushDeviceProfile(userAgent: string | null | undefined): {
  browser: PushBrowserName;
  os: PushOsName;
} {
  const ua = typeof userAgent === 'string' ? userAgent : '';
  let browser: PushBrowserName = 'Browser';
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/OPR\/|Opera/i.test(ua)) browser = 'Opera';
  else if (/CriOS\//i.test(ua)) browser = 'Chrome';
  else if (/Chrome\//i.test(ua) && !/Chromium/i.test(ua)) browser = 'Chrome';
  else if (/FxiOS\//i.test(ua) || /Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Safari\//i.test(ua) && !/Chrome/i.test(ua)) browser = 'Safari';

  let os: PushOsName = '';
  if (/Windows NT/i.test(ua)) os = 'Windows';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/iPhone|iPad|iPod/i.test(ua)) os = 'iOS';
  else if (/Mac OS X/i.test(ua)) os = 'macOS';
  else if (/Linux/i.test(ua)) os = 'Linux';

  return {browser, os};
}

/**
 * Decide how to save one browser subscription.
 * Each deviceKey is its own row. Nothing here drops other devices or enforces a cap.
 * Refresh only updates a browser that is already attached. Attach adds or reactivates one.
 */
export function planPushSubscriptionUpsert(args: {
  intent: PushUpsertIntent;
  userId: string;
  endpoint: string;
  deviceKey: string | null;
  rows: PushSubscriptionSnapshot[];
}): PushUpsertPlan {
  const endpointRow = args.rows.find((row) => row.endpoint === args.endpoint) ?? null;
  const deviceRow = args.deviceKey
    ? args.rows.find((row) => row.userId === args.userId && row.deviceKey === args.deviceKey) ?? null
    : null;

  if (args.intent === 'refresh') {
    const ownedEndpoint = endpointRow && endpointRow.userId === args.userId ? endpointRow : null;
    const target = deviceRow ?? ownedEndpoint;
    if (!target) return {action: 'missing'};
    if (target.revoked) return {action: 'revoked'};
    const deleteIds = ownedEndpoint && ownedEndpoint.id !== target.id ? [ownedEndpoint.id] : [];
    return {action: 'update', id: target.id, deleteIds};
  }

  const target = deviceRow ?? endpointRow;
  if (!target) return {action: 'create'};
  const deleteIds: number[] = [];
  if (endpointRow && endpointRow.id !== target.id) deleteIds.push(endpointRow.id);
  return {action: 'update', id: target.id, deleteIds};
}
