import axios from 'axios';
import { logger } from '@/server/services/core/LoggerService.js';
import {
  DEFAULT_PROBE_BVID,
  parseProxyId,
  parseProxyList,
  PROXY_PROBE_CONCURRENCY,
  type BilibiliProxyRef,
} from '@/misc/utils/data/bilibiliProxy.js';
import { fetchBilibiliHtml } from '@/misc/utils/data/bilibiliProxyAxios.js';
import { listHealthyIds } from '@/server/services/media/bilibiliProxyPool.js';
import { probeProxyAgainstBvid } from '@/server/services/media/bilibiliProxyWaves.js';

const LIST_URLS = [
  'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&country=cn&proxy_format=protocolipport&format=text',
  'https://hproxy.com/api/proxy-list?format=txt&country=CN',
  'https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/countries/CN/data.txt',
  'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/countries/CN/data.txt',
];

function probeBvid(): string {
  const fromEnv = process.env.BILIBILI_PROXY_PROBE_BVID?.trim();
  return fromEnv && /^BV[a-zA-Z0-9]+$/.test(fromEnv) ? fromEnv : DEFAULT_PROBE_BVID;
}

async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = items[index++];
      await fn(current);
    }
  });
  await Promise.all(workers);
}

async function pullPublicProxyList(): Promise<BilibiliProxyRef[]> {
  for (const url of LIST_URLS) {
    try {
      const response = await axios.get<string>(url, {
        timeout: 20000,
        responseType: 'text',
        validateStatus: (status) => status >= 200 && status < 300,
        headers: {
          Accept: 'text/plain,*/*',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        },
        proxy: false,
      });
      const parsed = parseProxyList(String(response.data ?? ''));
      if (parsed.length > 0) {
        logger.info(`Bilibili proxy list: ${parsed.length} unique CN entries from ${url}`);
        return parsed;
      }
      logger.warn(`Bilibili proxy list empty from ${url}`);
    } catch (error) {
      logger.warn(`Bilibili proxy list pull failed from ${url}`, error);
    }
  }
  return [];
}

async function htmlProbe(proxy: BilibiliProxyRef): Promise<boolean> {
  const result = await fetchBilibiliHtml(probeBvid(), { proxy });
  return 'html' in result;
}

export async function pullAndProbeNewBilibiliProxies(): Promise<void> {
  const listed = await pullPublicProxyList();
  if (listed.length === 0) {
    logger.warn('Bilibili proxy list pull produced no candidates');
    return;
  }
  const healthy = new Set(await listHealthyIds());
  const unknown = listed.filter((proxy) => !healthy.has(proxy.id));
  logger.info(`Bilibili proxy probe: ${unknown.length} unknown of ${listed.length}`);
  let hits = 0;
  await mapLimit(unknown, PROXY_PROBE_CONCURRENCY, async (proxy) => {
    const ok = await probeProxyAgainstBvid(proxy, htmlProbe);
    if (ok) hits += 1;
  });
  logger.info(`Bilibili proxy probe finished: ${hits} newly healthy`);
}

export async function reprobeHealthyBilibiliProxies(): Promise<void> {
  const ids = await listHealthyIds();
  logger.info(`Bilibili proxy re-probe: ${ids.length} healthy members`);
  let kept = 0;
  await mapLimit(ids, PROXY_PROBE_CONCURRENCY, async (id) => {
    const proxy = parseProxyId(id);
    if (!proxy) return;
    const ok = await probeProxyAgainstBvid(proxy, htmlProbe, { evictOnFail: true });
    if (ok) kept += 1;
  });
  logger.info(`Bilibili proxy re-probe finished: ${kept}/${ids.length} still healthy`);
}
