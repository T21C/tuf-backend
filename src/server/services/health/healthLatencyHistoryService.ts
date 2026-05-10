import { Op, QueryTypes } from 'sequelize';
import sequelize from '@/config/db.js';
import HealthLatencySample from '@/models/health/HealthLatencySample.js';
import { redis } from '@/server/services/core/RedisService.js';
import type { HealthLatencyComponent } from '@/models/health/HealthLatencySample.js';

const CACHE_PREFIX = 'health:latency:v1:';
const CACHE_TTL_SEC = 60;

export const HEALTH_LATENCY_WINDOWS = [
  '1h',
  '3h',
  '6h',
  '12h',
  '24h',
  '3d',
  '7d',
  '14d',
] as const;

export type HealthLatencyWindow = (typeof HEALTH_LATENCY_WINDOWS)[number];

export interface HealthLatencyPoint {
  at: string;
  database: number | null;
  main_server: number | null;
  cdn: number | null;
}

export interface HealthLatencyHistoryPayload {
  window: HealthLatencyWindow;
  bucketMs: number;
  from: string;
  to: string;
  points: HealthLatencyPoint[];
}

function windowToMs(w: HealthLatencyWindow): number {
  const map: Record<HealthLatencyWindow, number> = {
    '1h': 60 * 60 * 1000,
    '3h': 3 * 60 * 60 * 1000,
    '6h': 6 * 60 * 60 * 1000,
    '12h': 12 * 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
    '3d': 3 * 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '14d': 14 * 24 * 60 * 60 * 1000,
  };
  return map[w];
}

/**
 * Lower bound for `recorded_at` using only MySQL UTC clock math so comparisons match
 * naive DATETIME values regardless of session @@time_zone (same idea as binding through
 * Sequelize on ORM paths — see admin ratings-per-user using Op.gte / Op.lte).
 */
const UTC_RANGE_LOWER_SQL: Record<HealthLatencyWindow, string> = {
  '1h': 'DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 HOUR)',
  '3h': 'DATE_SUB(UTC_TIMESTAMP(), INTERVAL 3 HOUR)',
  '6h': 'DATE_SUB(UTC_TIMESTAMP(), INTERVAL 6 HOUR)',
  '12h': 'DATE_SUB(UTC_TIMESTAMP(), INTERVAL 12 HOUR)',
  '24h': 'DATE_SUB(UTC_TIMESTAMP(), INTERVAL 24 HOUR)',
  '3d': 'DATE_SUB(UTC_TIMESTAMP(), INTERVAL 3 DAY)',
  '7d': 'DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY)',
  '14d': 'DATE_SUB(UTC_TIMESTAMP(), INTERVAL 14 DAY)',
};

/** Align to minute for merging raw samples */
function minuteFloorMs(d: Date): number {
  return Math.floor(d.getTime() / 60000) * 60000;
}

function isLongWindow(w: HealthLatencyWindow): boolean {
  return w === '3d' || w === '7d' || w === '14d';
}

function bucketSecondsForWindow(w: HealthLatencyWindow): number {
  return isLongWindow(w) ? 900 : 60;
}

function componentKey(c: string): keyof Omit<HealthLatencyPoint, 'at'> | null {
  if (c === 'database') return 'database';
  if (c === 'main_server') return 'main_server';
  if (c === 'cdn') return 'cdn';
  return null;
}

export function parseLatencyWindow(raw: unknown): HealthLatencyWindow | null {
  if (typeof raw !== 'string') return null;
  return (HEALTH_LATENCY_WINDOWS as readonly string[]).includes(raw)
    ? (raw as HealthLatencyWindow)
    : null;
}

/**
 * Short windows: same pattern as admin statistics ratings-per-user — Sequelize model +
 * Op.between so Date ➔ MySQL conversion follows the pool dialect (see PoolManager timezone).
 */
async function fetchRawPoints(from: Date, to: Date): Promise<HealthLatencyPoint[]> {
  const rows = await HealthLatencySample.findAll({
    attributes: ['component', 'recordedAt', 'durationMs'],
    where: {
      recordedAt: {
        [Op.between]: [from, to],
      },
    },
    order: [['recordedAt', 'ASC']],
    raw: true,
  });

  const merged = new Map<
    number,
    { database: number | null; main_server: number | null; cdn: number | null }
  >();

  for (const row of rows) {
    const rawRow = row as unknown as Record<string, unknown>;
    const recorded = rawRow.recordedAt ?? rawRow.recorded_at;
    const ts = minuteFloorMs(new Date(recorded as string | Date));
    if (!merged.has(ts)) {
      merged.set(ts, { database: null, main_server: null, cdn: null });
    }
    const pt = merged.get(ts)!;
    const comp = String(rawRow.component ?? '');
    const key = componentKey(comp);
    if (!key) continue;
    const dm = rawRow.durationMs ?? rawRow.duration_ms;
    const v = dm === null || dm === undefined ? null : Math.round(Number(dm));
    pt[key] = v;
  }

  return [...merged.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ms, v]) => ({
      at: new Date(ms).toISOString(),
      ...v,
    }));
}

/**
 * Long windows: bucket in SQL with UTC bounds only (no JS Date bind in raw WHERE).
 */
async function fetchBucketedPoints(
  window: HealthLatencyWindow,
  bucketSec: number,
): Promise<HealthLatencyPoint[]> {
  type Row = {
    component: HealthLatencyComponent;
    bucket_at: Date;
    avg_ms: string | number | null;
  };

  const lowerSql = UTC_RANGE_LOWER_SQL[window];

  const rows = await sequelize.query<Row>(
    `SELECT
       component,
       bucket_at,
       ROUND(AVG(duration_ms)) AS avg_ms
     FROM (
       SELECT
         component,
         duration_ms,
         FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(recorded_at) / :bucketSec) * :bucketSec) AS bucket_at
       FROM health_latency_samples
       WHERE recorded_at >= ${lowerSql}
         AND recorded_at <= UTC_TIMESTAMP()
     ) AS buckets
     GROUP BY component, bucket_at
     ORDER BY bucket_at ASC`,
    {
      replacements: { bucketSec },
      type: QueryTypes.SELECT,
    },
  );

  const merged = new Map<
    number,
    { database: number | null; main_server: number | null; cdn: number | null }
  >();

  for (const row of rows) {
    const ts = new Date(row.bucket_at).getTime();
    if (!merged.has(ts)) {
      merged.set(ts, { database: null, main_server: null, cdn: null });
    }
    const pt = merged.get(ts)!;
    const key = componentKey(row.component);
    if (!key) continue;
    const raw = row.avg_ms;
    const n = raw === null || raw === undefined ? null : Math.round(Number(raw));
    pt[key] = n;
  }

  return [...merged.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ms, v]) => ({
      at: new Date(ms).toISOString(),
      ...v,
    }));
}

export async function getHealthLatencyHistory(
  window: HealthLatencyWindow,
): Promise<HealthLatencyHistoryPayload> {
  const cacheKey = `${CACHE_PREFIX}${window}`;
  const cached = await redis.get<HealthLatencyHistoryPayload>(cacheKey);
  if (cached) return cached;

  const now = new Date();
  const ms = windowToMs(window);
  const from = new Date(now.getTime() - ms);
  const long = isLongWindow(window);
  const bucketSec = bucketSecondsForWindow(window);

  const points = long
    ? await fetchBucketedPoints(window, bucketSec)
    : await fetchRawPoints(from, now);

  const bucketMs = long ? bucketSec * 1000 : 60000;

  const payload: HealthLatencyHistoryPayload = {
    window,
    bucketMs,
    from: from.toISOString(),
    to: now.toISOString(),
    points,
  };

  await redis.set(cacheKey, payload, CACHE_TTL_SEC);

  return payload;
}
