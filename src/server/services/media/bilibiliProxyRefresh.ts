import axios from 'axios';
import { logger } from '@/server/services/core/LoggerService.js';
import {
  DEFAULT_PROBE_BVID,
  mergeProxyLists,
  parseProxyId,
  parseProxyList,
  PROXY_PROBE_CONCURRENCY,
  type BilibiliProxyFailReason,
  type BilibiliProxyProtocol,
  type BilibiliProxyRef,
} from '@/misc/utils/data/bilibiliProxy.js';
import { fetchBilibiliHtml } from '@/misc/utils/data/bilibiliProxyAxios.js';
import { isIdQuarantined, listHealthyIds } from '@/server/services/media/bilibiliProxyPool.js';
import { probeProxyAgainstBvid } from '@/server/services/media/bilibiliProxyWaves.js';

interface ProxyListSource {
  url: string;
  protocol?: BilibiliProxyProtocol;
}

const LIST_SOURCES: ProxyListSource[] = [
  { url: 'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&country=cn&proxy_format=protocolipport&format=text' },
  { url: 'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&country=CN&protocol=http&proxy_format=protocolipport&format=text', protocol: 'http' },
  { url: 'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&country=CN&protocol=socks4&proxy_format=protocolipport&format=text', protocol: 'socks4' },
  { url: 'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&country=CN&protocol=socks5&proxy_format=protocolipport&format=text', protocol: 'socks5' },
  { url: 'https://www.proxy-list.download/api/v1/get?type=http&country=CN', protocol: 'http' },
  { url: 'https://www.proxy-list.download/api/v1/get?type=https&country=CN', protocol: 'http' },
  { url: 'https://www.proxy-list.download/api/v1/get?type=socks4&country=CN', protocol: 'socks4' },
  { url: 'https://www.proxy-list.download/api/v1/get?type=socks5&country=CN', protocol: 'socks5' },
  { url: 'https://proxylist.geonode.com/api/proxy-list?limit=500&page=1&sort_by=lastChecked&sort_type=desc&country=CN&protocols=http%2Chttps%2Csocks4%2Csocks5' },
  { url: 'https://hproxy.com/api/proxy-list?format=txt&country=CN' },
  { url: 'https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/countries/CN/data.txt' },
  { url: 'https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/countries/CN/data.json' },
  { url: 'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/countries/CN/data.txt' },
  { url: 'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/countries/CN/data.json' },
  { url: 'https://raw.githubusercontent.com/zloi-user/hideip.me/main/http.txt', protocol: 'http' },
  { url: 'https://raw.githubusercontent.com/zloi-user/hideip.me/main/socks4.txt', protocol: 'socks4' },
  { url: 'https://raw.githubusercontent.com/zloi-user/hideip.me/main/socks5.txt', protocol: 'socks5' },
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

function applyDefaultProtocol(
  list: BilibiliProxyRef[],
  protocol: BilibiliProxyProtocol | undefined,
): BilibiliProxyRef[] {
  if (!protocol) return list;
  return list.map((proxy) => ({
    ...proxy,
    protocol,
    id: `${protocol}://${proxy.host}:${proxy.port}`,
  }));
}

async function fetchProxyListBody(url: string): Promise<string | null> {
  try {
    const response = await axios.get<string>(url, {
      timeout: 20000,
      responseType: 'text',
      validateStatus: (status) => status >= 200 && status < 300,
      headers: {
        Accept: 'text/plain,application/json,*/*',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      },
      proxy: false,
    });
    return String(response.data ?? '');
  } catch (error) {
    logger.debug(`Bilibili proxy list pull failed from ${url}`, error);
    return null;
  }
}

async function pullPublicProxyList(): Promise<BilibiliProxyRef[]> {
  const bodies = await Promise.all(LIST_SOURCES.map((source) => fetchProxyListBody(source.url)));
  const parsedLists: BilibiliProxyRef[][] = [];
  let sources = 0;
  for (let i = 0; i < LIST_SOURCES.length; i++) {
    const body = bodies[i];
    if (body == null) continue;
    const parsed = applyDefaultProtocol(parseProxyList(body), LIST_SOURCES[i].protocol);
    if (parsed.length === 0) continue;
    sources += 1;
    parsedLists.push(parsed);
  }
  const merged = mergeProxyLists(parsedLists);
  if (merged.length > 0) {
    logger.info(
      `Bilibili proxy list: ${merged.length} unique candidates from ${sources}/${LIST_SOURCES.length} sources`,
    );
  }
  return merged;
}

async function htmlProbe(proxy: BilibiliProxyRef): Promise<true | BilibiliProxyFailReason> {
  const result = await fetchBilibiliHtml(probeBvid(), { proxy });
  return 'html' in result ? true : result.reason;
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
    if (await isIdQuarantined(proxy.id)) return;
    const ok = await probeProxyAgainstBvid(proxy, htmlProbe);
    if (ok) hits += 1;
  });
  logger.info(`Bilibili proxy probe finished: ${hits} newly healthy`);
}

export async function reprobeHealthyBilibiliProxies(): Promise<void> {
  const ids = await listHealthyIds();
  await mapLimit(ids, PROXY_PROBE_CONCURRENCY, async (id) => {
    const proxy = parseProxyId(id);
    if (!proxy) return;
    await probeProxyAgainstBvid(proxy, htmlProbe, { evictOnFail: true });
  });
}
