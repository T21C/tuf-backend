import { redis } from '@/server/services/core/RedisService.js';
import { logger } from '@/server/services/core/LoggerService.js';
import {
  parseProxyId,
  pickUnused,
  PROXY_FAIL_EVICT_AFTER,
  type BilibiliProxyRef,
} from '@/misc/utils/data/bilibiliProxy.js';

const OK_KEY = 'bilibili:proxies:ok';
const META_KEY = 'bilibili:proxies:meta';

interface ProxyMeta {
  protocol: BilibiliProxyRef['protocol'];
  lastOk: number | null;
  lastFail: number | null;
  failCount: number;
}

function emptyMeta(protocol: BilibiliProxyRef['protocol']): ProxyMeta {
  return { protocol, lastOk: null, lastFail: null, failCount: 0 };
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

export async function markProxyOk(proxy: BilibiliProxyRef): Promise<void> {
  try {
    const client = await redisClient();
    if (!client) return;
    const now = Date.now();
    const prev = (await readMeta(client, proxy.id)) ?? emptyMeta(proxy.protocol);
    await client.zAdd(OK_KEY, { score: now, value: proxy.id });
    await writeMeta(client, proxy.id, {
      protocol: proxy.protocol,
      lastOk: now,
      lastFail: prev.lastFail,
      failCount: 0,
    });
  } catch (error) {
    logger.warn(`Bilibili proxy pool: markOk failed for ${proxy.id}`, error);
  }
}

export async function markProxyFail(proxy: BilibiliProxyRef): Promise<void> {
  try {
    const client = await redisClient();
    if (!client) return;
    const now = Date.now();
    const prev = (await readMeta(client, proxy.id)) ?? emptyMeta(proxy.protocol);
    const failCount = (prev.failCount || 0) + 1;
    const meta: ProxyMeta = {
      protocol: proxy.protocol,
      lastOk: prev.lastOk,
      lastFail: now,
      failCount,
    };
    await writeMeta(client, proxy.id, meta);
    if (failCount >= PROXY_FAIL_EVICT_AFTER) {
      await client.zRem(OK_KEY, proxy.id);
    }
  } catch (error) {
    logger.warn(`Bilibili proxy pool: markFail failed for ${proxy.id}`, error);
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
