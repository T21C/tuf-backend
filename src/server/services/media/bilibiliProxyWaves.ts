import { logger } from '@/server/services/core/LoggerService.js';
import {
  PROXY_WAVE_SIZES,
  type BilibiliProxyFailReason,
  type BilibiliProxyRef,
} from '@/misc/utils/data/bilibiliProxy.js';
import { isAbortError } from '@/misc/utils/data/bilibiliProxyAxios.js';
import {
  evictProxy,
  getHealthyCount,
  getProxyById,
  markProxyFail,
  markProxyOk,
  pickUnusedProxies,
} from '@/server/services/media/bilibiliProxyPool.js';

export async function raceProxyWaves<T>(
  attempt: (
    proxy: BilibiliProxyRef,
    signal: AbortSignal,
  ) => Promise<{ value: T } | { reason: BilibiliProxyFailReason; proxyOk?: boolean }>,
  opts: { preferredId?: string | null; logLabel: string } = { logLabel: 'bilibili' },
): Promise<{ proxy: BilibiliProxyRef; value: T } | null> {
  const exclude = new Set<string>();

  if (opts.preferredId) {
    const preferred = await getProxyById(opts.preferredId);
    if (preferred) {
      const won = await raceOneWave([preferred], attempt, opts.logLabel);
      if (won) return won;
      exclude.add(preferred.id);
    }
  }

  const healthy = await getHealthyCount();
  if (healthy <= 0) return null;

  for (const size of PROXY_WAVE_SIZES) {
    const picked = await pickUnusedProxies(size, exclude);
    if (picked.length === 0) return null;
    const won = await raceOneWave(picked, attempt, opts.logLabel);
    for (const proxy of picked) exclude.add(proxy.id);
    if (won) return won;
  }

  return null;
}

async function raceOneWave<T>(
  proxies: BilibiliProxyRef[],
  attempt: (
    proxy: BilibiliProxyRef,
    signal: AbortSignal,
  ) => Promise<{ value: T } | { reason: BilibiliProxyFailReason; proxyOk?: boolean }>,
  logLabel: string,
): Promise<{ proxy: BilibiliProxyRef; value: T } | null> {
  const ac = new AbortController();
  const results = await Promise.all(
    proxies.map(async (proxy) => {
      try {
        const result = await attempt(proxy, ac.signal);
        if ('value' in result) {
          ac.abort();
          await markProxyOk(proxy);
          return { proxy, value: result.value };
        }
        logger.warn(
          `Bilibili ${logLabel} miss via ${proxy.id}: ${result.reason}`,
        );
        if (result.proxyOk) await markProxyOk(proxy);
        else await markProxyFail(proxy);
        return null;
      } catch (error) {
        if (isAbortError(error) || ac.signal.aborted) return null;
        logger.warn(`Bilibili ${logLabel} miss via ${proxy.id}: timeout`, error);
        await markProxyFail(proxy);
        return null;
      }
    }),
  );
  return results.find((row) => row != null) ?? null;
}

export async function probeProxyAgainstBvid(
  proxy: BilibiliProxyRef,
  attempt: (proxy: BilibiliProxyRef) => Promise<boolean>,
  opts: { evictOnFail?: boolean } = {},
): Promise<boolean> {
  try {
    const ok = await attempt(proxy);
    if (ok) {
      await markProxyOk(proxy);
      return true;
    }
    if (opts.evictOnFail) await evictProxy(proxy.id);
    else await markProxyFail(proxy);
    return false;
  } catch {
    if (opts.evictOnFail) await evictProxy(proxy.id);
    else await markProxyFail(proxy);
    return false;
  }
}
