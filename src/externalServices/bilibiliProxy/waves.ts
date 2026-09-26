import {
  PROXY_WAVE_SIZES,
  buildProxyWave,
  parseProxyId,
  type BilibiliProxyFailReason,
  type BilibiliProxyRef,
} from './helpers.js';
import { isAbortError } from './axios.js';
import {
  demoteProxy,
  evictProxy,
  getHealthyCount,
  isSkippedForCover,
  listHealthyIds,
  markProxyFail,
  markProxyOk,
} from './pool.js';

export async function raceProxyWaves<T>(
  attempt: (
    proxy: BilibiliProxyRef,
    signal: AbortSignal,
  ) => Promise<{ value: T } | { reason: BilibiliProxyFailReason; proxyOk?: boolean }>,
  opts: {
    preferredId?: string | null;
    logLabel: string;
    skipCoverLosers?: boolean;
  } = { logLabel: 'bilibili' },
): Promise<{ proxy: BilibiliProxyRef; value: T } | null> {
  const exclude = new Set<string>();
  if (opts.skipCoverLosers) {
    const healthy = await listHealthyIds();
    for (const id of healthy) {
      if (isSkippedForCover(id)) exclude.add(id);
    }
  }

  const healthy = await getHealthyCount();
  if (healthy <= 0) return null;

  let preferredId = opts.preferredId ?? null;
  if (preferredId && exclude.has(preferredId)) preferredId = null;
  const coverSkipExcludes = new Set(exclude);

  for (const size of PROXY_WAVE_SIZES) {
    let ids = buildProxyWave({
      healthyIds: await listHealthyIds(),
      size,
      exclude,
      preferredId,
    });
    if (ids.length === 0 && coverSkipExcludes.size > 0) {
      for (const id of coverSkipExcludes) exclude.delete(id);
      coverSkipExcludes.clear();
      ids = buildProxyWave({
        healthyIds: await listHealthyIds(),
        size,
        exclude,
        preferredId,
      });
    }
    preferredId = null;
    if (ids.length === 0) return null;
    const proxies: BilibiliProxyRef[] = [];
    for (const id of ids) {
      const parsed = parseProxyId(id);
      if (parsed) proxies.push(parsed);
    }
    if (proxies.length === 0) return null;
    const won = await raceOneWave(proxies, attempt, opts.skipCoverLosers === true);
    for (const proxy of proxies) exclude.add(proxy.id);
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
  demoteAborts: boolean,
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
        if (result.proxyOk) await markProxyOk(proxy);
        else await markProxyFail(proxy, result.reason);
        return null;
      } catch (error) {
        if (isAbortError(error) || ac.signal.aborted) {
          if (demoteAborts) await demoteProxy(proxy);
          return null;
        }
        await markProxyFail(proxy, 'timeout');
        return null;
      }
    }),
  );
  return results.find((row) => row != null) ?? null;
}

export async function probeProxyAgainstBvid(
  proxy: BilibiliProxyRef,
  attempt: (proxy: BilibiliProxyRef) => Promise<true | BilibiliProxyFailReason>,
  opts: { evictOnFail?: boolean } = {},
): Promise<boolean> {
  try {
    const result = await attempt(proxy);
    if (result === true) {
      await markProxyOk(proxy);
      return true;
    }
    if (opts.evictOnFail) await evictProxy(proxy.id);
    await markProxyFail(proxy, result);
    return false;
  } catch {
    if (opts.evictOnFail) await evictProxy(proxy.id);
    await markProxyFail(proxy, 'timeout');
    return false;
  }
}
