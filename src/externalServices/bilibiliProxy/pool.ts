import { redis } from '@/server/services/core/RedisService.js';
import { logger } from '@/server/services/core/LoggerService.js';
import {
  applyProxyFail,
  isProxyQuarantined,
  parseProxyId,
  pickUnused,
  type BilibiliProxyFailReason,
  type BilibiliProxyRef,
} from './helpers.js';

const OK_KEY = 'bilibili:proxies:ok';
const META_KEY = 'bilibili:proxies:meta';
const COVER_SKIP_MS = 15 * 60 * 1000;
const coverSkipUntil = new Map<string, number>();

interface ProxyMeta {
  protocol: BilibiliProxyRef['protocol'];
  lastOk: number | null;
  lastFail: number | null;
  failCount: number;
  timeoutCount?: number;
  lastFailReason?: BilibiliProxyFailReason | null;
  quarantinedUntil?: number | null;
}

function emptyMeta(protocol: BilibiliProxyRef['protocol']): ProxyMeta {
  return { protocol, lastOk: null, lastFail: null, failCount: 0, timeoutCount: 0 };
}

async function redisClient(): Promise<any | null> {
  if (!redis.isConnected()) return null;
  return redis.getClient();
}

async function readMeta(client: any, id: string): Promise<ProxyMeta | null> {
  const raw = await client.hGet(META_KEY, id);
  if (!raw || typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw) as ProxyMeta;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeMeta(client: any, id: string, meta: ProxyMeta): Promise<void> {
  await client.hSet(META_KEY, id, JSON.stringify(meta));
}

export function skipProxyForCover(id: string, now = Date.now()): void {
  coverSkipUntil.set(id, now + COVER_SKIP_MS);
}

export function isSkippedForCover(id: string, now = Date.now()): boolean {
  const until = coverSkipUntil.get(id);
  if (until == null) return false;
  if (until <= now) {
    coverSkipUntil.delete(id);
    return false;
  }
  return true;
}

export async function getHealthyCount(): Promise<number> {
  try {
    const client = await redisClient();
    if (!client) return 0;
    return Number(await client.zCard(OK_KEY)) || 0;
  } catch (error) {
    logger.warn('Bilibili proxy pool: healthy count failed', error);
    return 0;
  }
}

export async function listHealthyIds(): Promise<string[]> {
  try {
    const client = await redisClient();
    if (!client) return [];
    const ids = await client.zRange(OK_KEY, 0, -1, { REV: true });
    return Array.isArray(ids) ? ids.filter((id: unknown) => typeof id === 'string') : [];
  } catch (error) {
    logger.warn('Bilibili proxy pool: list healthy failed', error);
    return [];
  }
}

export async function pickUnusedProxies(
  n: number,
  exclude: ReadonlySet<string> = new Set(),
): Promise<BilibiliProxyRef[]> {
  const ids = pickUnused(await listHealthyIds(), n, exclude);
  const out: BilibiliProxyRef[] = [];
  for (const id of ids) {
    const parsed = parseProxyId(id);
    if (parsed) out.push(parsed);
  }
  return out;
}

export async function getProxyById(id: string): Promise<BilibiliProxyRef | null> {
  const parsed = parseProxyId(id);
  if (!parsed) return null;
  try {
    const client = await redisClient();
    if (!client) return parsed;
    const score = await client.zScore(OK_KEY, id);
    if (score == null) return null;
    return parsed;
  } catch {
    return parsed;
  }
}

export async function isIdQuarantined(id: string, now = Date.now()): Promise<boolean> {
  try {
    const client = await redisClient();
    if (!client) return false;
    const meta = await readMeta(client, id);
    return isProxyQuarantined(meta?.quarantinedUntil, now);
  } catch {
    return false;
  }
}

export async function markProxyOk(proxy: BilibiliProxyRef): Promise<void> {
  try {
    const client = await redisClient();
    if (!client) return;
    const now = Date.now();
    const prev = (await readMeta(client, proxy.id)) ?? emptyMeta(proxy.protocol);
    if (isProxyQuarantined(prev.quarantinedUntil, now)) {
      logger.debug(
        `Bilibili proxy ${proxy.id} still quarantined until ${new Date(prev.quarantinedUntil ?? 0).toISOString()}; not re-adding after success`,
      );
      return;
    }
    await client.zAdd(OK_KEY, { score: now, value: proxy.id });
    await writeMeta(client, proxy.id, {
      protocol: proxy.protocol,
      lastOk: now,
      lastFail: prev.lastFail,
      failCount: 0,
      timeoutCount: 0,
      lastFailReason: null,
      quarantinedUntil: null,
    });
  } catch (error) {
    logger.warn(`Bilibili proxy pool: markOk failed for ${proxy.id}`, error);
  }
}

export async function markProxyFail(
  proxy: BilibiliProxyRef,
  reason: BilibiliProxyFailReason = 'no_meta',
): Promise<void> {
  try {
    const client = await redisClient();
    if (!client) return;
    const now = Date.now();
    const prev = (await readMeta(client, proxy.id)) ?? emptyMeta(proxy.protocol);
    const next = applyProxyFail(
      {
        failCount: prev.failCount,
        timeoutCount: prev.timeoutCount,
        lastOk: prev.lastOk,
      },
      reason,
      now,
    );
    await writeMeta(client, proxy.id, {
      protocol: proxy.protocol,
      lastOk: next.lastOk,
      lastFail: next.lastFail,
      failCount: next.failCount,
      timeoutCount: next.timeoutCount,
      lastFailReason: next.lastFailReason,
      quarantinedUntil: next.quarantinedUntil ?? prev.quarantinedUntil ?? null,
    });
    if (next.evict) {
      await client.zRem(OK_KEY, proxy.id);
      if (reason === 'timeout') {
        skipProxyForCover(proxy.id, now);
        logger.debug(
          `Bilibili proxy evicted ${proxy.id} after timeout; quarantined until ${new Date(next.quarantinedUntil ?? now).toISOString()}`,
        );
      }
    }
  } catch (error) {
    logger.warn(`Bilibili proxy pool: markFail failed for ${proxy.id}`, error);
  }
}

/** Keep in the pool but send to the back so a racing timeout does not stay preferred. */
export async function demoteProxy(proxy: BilibiliProxyRef): Promise<void> {
  skipProxyForCover(proxy.id);
  try {
    const client = await redisClient();
    if (!client) return;
    const score = await client.zScore(OK_KEY, proxy.id);
    if (score == null) return;
    await client.zAdd(OK_KEY, { score: 1, value: proxy.id });
  } catch (error) {
    logger.warn(`Bilibili proxy pool: demote failed for ${proxy.id}`, error);
  }
}

export async function evictProxy(id: string): Promise<void> {
  try {
    const client = await redisClient();
    if (!client) return;
    await client.zRem(OK_KEY, id);
  } catch (error) {
    logger.warn(`Bilibili proxy pool: evict failed for ${id}`, error);
  }
}
