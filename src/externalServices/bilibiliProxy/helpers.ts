export type BilibiliProxyProtocol = 'http' | 'socks4' | 'socks5';

export type BilibiliProxyFailReason = 'timeout' | 'waf412' | 'no_meta';

export interface BilibiliProxyRef {
  id: string;
  protocol: BilibiliProxyProtocol;
  host: string;
  port: number;
}

export interface BilibiliViewData {
  aid: string;
  bvid: string;
  cid: string;
  pubdate: number;
  pic: string;
  title: string;
  owner: {
    name: string;
    face: string;
  };
  viaProxyId?: string;
}

export const BILIBILI_REQUEST_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Referer: 'https://www.bilibili.com/',
  Origin: 'https://www.bilibili.com',
};

export const DEFAULT_PROBE_BVID = 'BV1zCtq61Eoi';
export const DEFAULT_WAVE_TIMEOUT_MS = 8000;
export const PROXY_WAVE_SIZES = [2, 4, 8] as const;
export const PROXY_FAIL_EVICT_AFTER = 3;
export const PROXY_PROBE_CONCURRENCY = 12;
/** Pull lists again when the healthy set is this size or smaller. */
export const PROXY_POOL_DRY_THRESHOLD = 3;
/** Drop a proxy from the healthy set on the first request timeout. */
export const PROXY_TIMEOUT_EVICT_AFTER = 1;
/** HTML/probe success must not re-add a proxy that just timed out. */
export const PROXY_TIMEOUT_QUARANTINE_MS = 60 * 60 * 1000;

export type BilibiliFetchMode = 'direct' | 'proxy' | 'fail_closed';

export function resolveBilibiliFetchMode(opts: {
  nodeEnv: string | undefined;
  disabled?: boolean;
  healthyCount: number;
}): BilibiliFetchMode {
  if (opts.disabled) return 'direct';
  if (opts.nodeEnv !== 'production' && opts.nodeEnv !== 'staging') return 'direct';
  if (opts.healthyCount <= 0) return 'fail_closed';
  return 'proxy';
}

export function shouldStartBilibiliProxyCron(env: {
  NODE_ENV?: string;
  BILIBILI_PROXY_DISABLED?: string;
  BILIBILI_PROXY_ENABLED?: string;
}): boolean {
  if (env.BILIBILI_PROXY_DISABLED === '1') return false;
  if (env.NODE_ENV === 'test') return false;
  if (env.BILIBILI_PROXY_ENABLED === '1') return true;
  return env.NODE_ENV === 'production' || env.NODE_ENV === 'staging';
}

export function isProxyPoolDry(healthyCount: number): boolean {
  return healthyCount <= PROXY_POOL_DRY_THRESHOLD;
}

export function pickUnused(
  ids: readonly string[],
  n: number,
  exclude: ReadonlySet<string> = new Set(),
): string[] {
  const out: string[] = [];
  if (n <= 0) return out;
  for (const id of ids) {
    if (exclude.has(id)) continue;
    out.push(id);
    if (out.length >= n) break;
  }
  return out;
}

/** First wave includes preferred (if still healthy) plus unused peers so a timeout does not stall alone. */
export function buildProxyWave(opts: {
  healthyIds: readonly string[];
  size: number;
  exclude?: ReadonlySet<string>;
  preferredId?: string | null;
}): string[] {
  const exclude = new Set(opts.exclude);
  const out: string[] = [];
  if (
    opts.preferredId &&
    !exclude.has(opts.preferredId) &&
    opts.healthyIds.includes(opts.preferredId)
  ) {
    out.push(opts.preferredId);
    exclude.add(opts.preferredId);
  }
  out.push(...pickUnused(opts.healthyIds, opts.size - out.length, exclude));
  return out;
}

export function isProxyQuarantined(quarantinedUntil: number | null | undefined, now: number): boolean {
  return typeof quarantinedUntil === 'number' && quarantinedUntil > now;
}

export function shouldEvictAfterFail(reason: BilibiliProxyFailReason, counts: {
  failCount: number;
  timeoutCount: number;
}): boolean {
  if (reason === 'timeout') return counts.timeoutCount >= PROXY_TIMEOUT_EVICT_AFTER;
  return counts.failCount >= PROXY_FAIL_EVICT_AFTER;
}

export function applyProxyFail(
  prev: { failCount?: number; timeoutCount?: number; lastOk?: number | null },
  reason: BilibiliProxyFailReason,
  now: number,
): {
  failCount: number;
  timeoutCount: number;
  lastFail: number;
  lastFailReason: BilibiliProxyFailReason;
  lastOk: number | null;
  quarantinedUntil: number | null;
  evict: boolean;
} {
  const failCount = (prev.failCount || 0) + 1;
  const timeoutCount = reason === 'timeout' ? (prev.timeoutCount || 0) + 1 : prev.timeoutCount || 0;
  const evict = shouldEvictAfterFail(reason, { failCount, timeoutCount });
  return {
    failCount,
    timeoutCount,
    lastFail: now,
    lastFailReason: reason,
    lastOk: prev.lastOk ?? null,
    quarantinedUntil: reason === 'timeout' ? now + PROXY_TIMEOUT_QUARANTINE_MS : null,
    evict,
  };
}

export function judgeBilibiliHtml(html: string | null | undefined): BilibiliProxyFailReason | 'ok' {
  if (typeof html !== 'string' || html.length === 0) return 'no_meta';
  if (/错误号:\s*412/u.test(html) || /security control/i.test(html)) return 'waf412';
  if (html.includes('videoData') || html.includes('og:title')) return 'ok';
  return 'no_meta';
}

function unescapeJsonString(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
  }
}

function decodePic(raw: string): string {
  const decoded = raw.includes('\\') ? unescapeJsonString(raw) : raw;
  return decoded.replace(/@[^/?#]+$/, '');
}

export function normalizePicUrl(pic: string): string | null {
  const trimmed = pic.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('//')) return `https:${trimmed}`;
  if (trimmed.startsWith('http://')) return `https://${trimmed.slice('http://'.length)}`;
  if (trimmed.startsWith('https://')) return trimmed;
  return null;
}

/** Archive stills only, e.g. i0.hdslb.com/bfs/archive/<hash>.jpg */
export function isArchiveCover(pic: string): boolean {
  try {
    const url = new URL(pic);
    return (
      /(^|\.)hdslb\.com$/i.test(url.hostname) &&
      /^\/bfs\/archive\/[a-zA-Z0-9]+\.jpe?g$/i.test(url.pathname)
    );
  } catch {
    return false;
  }
}

export function parseBilibiliViewHtml(bvid: string, html: string): BilibiliViewData | null {
  if (judgeBilibiliHtml(html) !== 'ok') return null;

  const marker = `"videoData":{"bvid":"${bvid}"`;
  const start = html.indexOf(marker);
  const slice = start >= 0 ? html.slice(start, start + 20000) : '';
  const picRaw =
    slice.match(/"pic":"([^"]+)"/)?.[1] ??
    html.match(/property="og:image" content="([^"]+)"/)?.[1];
  if (!picRaw) return null;

  const pic = decodePic(picRaw);
  if (!isArchiveCover(normalizePicUrl(pic) || '')) return null;

  const title =
    unescapeJsonString(slice.match(/"title":"((?:\\.|[^"\\])*)"/)?.[1] ?? '') ||
    html.match(/property="og:title" content="([^"]*)"/)?.[1] ||
    bvid;
  const ownerName = unescapeJsonString(
    slice.match(/"owner":\{"mid":\d+,"name":"((?:\\.|[^"\\])*)"/)?.[1] ?? '',
  );
  const pubdate = Number(slice.match(/"pubdate":(\d+)/)?.[1] ?? '0');
  const aid = slice.match(/"aid":(\d+)/)?.[1] ?? '';
  const cid = slice.match(/"cid":(\d+)/)?.[1] ?? '';

  return {
    aid,
    bvid,
    cid,
    pubdate,
    pic,
    title,
    owner: { name: ownerName, face: '' },
  };
}

function normalizeProtocol(raw: string): BilibiliProxyProtocol | null {
  const p = raw.replace(/:$/, '').toLowerCase();
  if (p === 'http' || p === 'https') return 'http';
  if (p === 'socks4' || p === 'socks4a') return 'socks4';
  if (p === 'socks' || p === 'socks5' || p === 'socks5h') return 'socks5';
  return null;
}

function isPublicIpv4(host: string): boolean {
  const parts = host.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 192 && b === 168) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a >= 224) return false;
  return true;
}

const IPV4_PROXY_SOURCE =
  '(?:(https?|socks4a?|socks5h?|socks):\\/\\/)?(\\d{1,3}(?:\\.\\d{1,3}){3}):(\\d{1,5})(?::([A-Za-z]{2,3}))?';

function isCnCountryTag(tag: string | undefined): boolean {
  if (!tag) return true;
  const upper = tag.toUpperCase();
  return upper === 'CN' || upper === 'CHN';
}

export function parseProxyEntry(raw: string): BilibiliProxyRef | null {
  const line = raw.trim();
  if (!line || line.startsWith('#') || line.startsWith('[')) return null;

  const tagged = new RegExp(IPV4_PROXY_SOURCE, 'i').exec(line);
  if (!tagged) return null;
  if (!isCnCountryTag(tagged[4])) return null;

  const protocol = normalizeProtocol(tagged[1] || 'http');
  const host = tagged[2];
  const port = Number(tagged[3]);
  if (!protocol || !host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (!isPublicIpv4(host)) return null;

  return {
    id: `${protocol}://${host}:${port}`,
    protocol,
    host,
    port,
  };
}

function addParsedProxy(out: BilibiliProxyRef[], seen: Set<string>, raw: string): void {
  const parsed = parseProxyEntry(raw);
  if (!parsed || seen.has(parsed.id)) return;
  seen.add(parsed.id);
  out.push(parsed);
}

function collectProxiesFromJson(value: unknown, out: BilibiliProxyRef[], seen: Set<string>): void {
  if (typeof value === 'string') {
    addParsedProxy(out, seen, value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectProxiesFromJson(item, out, seen);
    return;
  }
  if (!value || typeof value !== 'object') return;

  const rec = value as Record<string, unknown>;
  const ip = typeof rec.ip === 'string' ? rec.ip : typeof rec.host === 'string' ? rec.host : null;
  const port = rec.port;
  if (ip && (typeof port === 'number' || typeof port === 'string')) {
    const protoRaw = Array.isArray(rec.protocols)
      ? String(rec.protocols[0] ?? 'http')
      : typeof rec.protocol === 'string'
        ? rec.protocol
        : typeof rec.type === 'string'
          ? rec.type
          : 'http';
    addParsedProxy(out, seen, `${protoRaw}://${ip}:${port}`);
  }
  for (const nested of Object.values(rec)) collectProxiesFromJson(nested, out, seen);
}

export function parseProxyList(text: string): BilibiliProxyRef[] {
  const seen = new Set<string>();
  const out: BilibiliProxyRef[] = [];
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      collectProxiesFromJson(JSON.parse(trimmed), out, seen);
    } catch {
      // Fall through to regex scan of the raw body.
    }
  }
  const scanner = new RegExp(IPV4_PROXY_SOURCE, 'gi');
  for (const match of text.matchAll(scanner)) {
    const country = match[4];
    const raw = country
      ? `${match[1] ? `${match[1]}://` : ''}${match[2]}:${match[3]}:${country}`
      : `${match[1] ? `${match[1]}://` : ''}${match[2]}:${match[3]}`;
    addParsedProxy(out, seen, raw);
  }
  return out;
}

export function mergeProxyLists(lists: readonly BilibiliProxyRef[][]): BilibiliProxyRef[] {
  const seen = new Set<string>();
  const out: BilibiliProxyRef[] = [];
  for (const list of lists) {
    for (const proxy of list) {
      if (seen.has(proxy.id)) continue;
      seen.add(proxy.id);
      out.push(proxy);
    }
  }
  return out;
}

export function proxyAgentUrl(proxy: BilibiliProxyRef): string {
  if (proxy.protocol === 'socks4') return `socks4://${proxy.host}:${proxy.port}`;
  if (proxy.protocol === 'socks5') return `socks5h://${proxy.host}:${proxy.port}`;
  return `http://${proxy.host}:${proxy.port}`;
}

export function parseProxyId(id: string): BilibiliProxyRef | null {
  return parseProxyEntry(id);
}
