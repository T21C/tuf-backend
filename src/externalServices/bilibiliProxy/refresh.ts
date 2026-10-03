import axios from 'axios';
import { logger } from '@/server/services/core/LoggerService.js';
import {
  DEFAULT_PROBE_BVID,
  mergeProxyLists,
  parseProxyId,
  parseProxyList,
  PROXY_PROBE_CONCURRENCY,
  withDeadline,
  type BilibiliProxyFailReason,
  type BilibiliProxyProtocol,
  type BilibiliProxyRef,
} from './helpers.js';
import { fetchBilibiliHtml } from './axios.js';
import { isIdQuarantined, listHealthyIds } from './pool.js';
import { probeProxyAgainstBvid } from './waves.js';

interface ProxyListSource {
  name: string;
  url: string;
  protocol?: BilibiliProxyProtocol;
}

const LIST_FETCH_TIMEOUT_MS = 20_000;

const LIST_SOURCES: ProxyListSource[] = [
  { name: 'proxyscrape', url: 'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&country=cn&proxy_format=protocolipport&format=text' },
  { name: 'proxyscrape-http', url: 'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&country=CN&protocol=http&proxy_format=protocolipport&format=text', protocol: 'http' },
  { name: 'proxyscrape-socks4', url: 'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&country=CN&protocol=socks4&proxy_format=protocolipport&format=text', protocol: 'socks4' },
  { name: 'proxyscrape-socks5', url: 'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&country=CN&protocol=socks5&proxy_format=protocolipport&format=text', protocol: 'socks5' },
  { name: 'geonode', url: 'https://proxylist.geonode.com/api/proxy-list?limit=500&page=1&sort_by=lastChecked&sort_type=desc&country=CN&protocols=http%2Chttps%2Csocks4%2Csocks5' },
  { name: 'hproxy', url: 'https://hproxy.com/api/proxy-list?format=txt&country=CN' },
  { name: 'proxifly', url: 'https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/countries/CN/data.txt' },
  { name: 'proxifly-json', url: 'https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/countries/CN/data.json' },
  { name: 'hideip-http', url: 'https://raw.githubusercontent.com/zloi-user/hideip.me/main/http.txt', protocol: 'http' },
  { name: 'hideip-socks4', url: 'https://raw.githubusercontent.com/zloi-user/hideip.me/main/socks4.txt', protocol: 'socks4' },
  { name: 'hideip-socks5', url: 'https://raw.githubusercontent.com/zloi-user/hideip.me/main/socks5.txt', protocol: 'socks5' },
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

async function fetchProxyListBody(url: string): Promise<{ body: string | null; detail: string }> {
  const deadline = withDeadline(LIST_FETCH_TIMEOUT_MS);
  try {
    const response = await axios.get<string>(url, {
      timeout: LIST_FETCH_TIMEOUT_MS,
      signal: deadline.signal,
      responseType: 'text',
      validateStatus: () => true,
      headers: {
        Accept: 'text/plain,application/json,*/*',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      },
      proxy: false,
    });
    if (response.status < 200 || response.status >= 300) {
      return { body: null, detail: `http ${response.status}` };
    }
    return { body: String(response.data ?? ''), detail: 'ok' };
  } catch (error) {
    if (deadline.timedOut()) return { body: null, detail: 'timeout' };
    const message = error instanceof Error ? error.message : String(error);
    return { body: null, detail: message.slice(0, 120) };
  } finally {
    deadline.stop();
  }
}

async function pullPublicProxyList(): Promise<BilibiliProxyRef[]> {
  const bodies = await Promise.all(LIST_SOURCES.map((source) => fetchProxyListBody(source.url)));
  const parsedLists: BilibiliProxyRef[][] = [];
  const failures: string[] = [];
  let sources = 0;
  for (let i = 0; i < LIST_SOURCES.length; i++) {
    const fetched = bodies[i];
    if (!fetched || fetched.body == null) {
      failures.push(`${LIST_SOURCES[i].name} ${fetched?.detail ?? 'failed'}`);
      continue;
    }
    const parsed = applyDefaultProtocol(parseProxyList(fetched.body), LIST_SOURCES[i].protocol);
    if (parsed.length === 0) {
      failures.push(`${LIST_SOURCES[i].name} 0 parsed`);
      continue;
    }
    sources += 1;
    parsedLists.push(parsed);
  }
  const merged = mergeProxyLists(parsedLists);
  const failureNote = failures.length > 0 ? `; failed ${failures.join(', ')}` : '';
  logger.info(
    `Bilibili proxy list: ${merged.length} unique candidates from ${sources}/${LIST_SOURCES.length} sources${failureNote}`,
  );
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
