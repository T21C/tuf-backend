import {
  cleanSingleVideoUrl,
  cleanVideoLinks,
  getPrimaryVideoLink,
  splitVideoLinks,
} from '@/misc/utils/data/videoLinkParts.js';

const B23_HOSTS = new Set(['b23.tv', 'www.b23.tv']);
const B23_PATH_CODE = /^\/([a-zA-Z0-9]+)$/;
const ALLOWED_BILIBILI_HOSTS = new Set(['bilibili.com', 'www.bilibili.com', 'm.bilibili.com']);
const B23_RESOLVE_TIMEOUT_MS = 8000;

interface ParsedB23TvUrl {
  shortCode: string;
  apiInput: string;
}

/**
 * Parse a user-supplied URL and return b23.tv short-link parts only when the
 * hostname is actually b23.tv (not a substring embedded in another URL).
 */
function parseB23TvUrl(url: string): ParsedB23TvUrl | null {
  const trimmed = url?.trim?.() ?? '';
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  if (!B23_HOSTS.has(host)) {
    return null;
  }

  const pathMatch = parsed.pathname.match(B23_PATH_CODE);
  if (!pathMatch?.[1]) {
    return null;
  }

  return {
    shortCode: pathMatch[1],
    apiInput: `${parsed.hostname}${parsed.pathname}`,
  };
}

/**
 * Canonicalise user-supplied video URLs to a stable form so duplicate detection
 * can compare them exactly. Multi-link strings are preserved; each token is cleaned.
 */
export function cleanVideoUrl(url: string): string {
  return cleanVideoLinks(url);
}

export { getPrimaryVideoLink, splitVideoLinks };

export function isB23ShortUrl(url: string): boolean {
  return parseB23TvUrl(url) !== null;
}

/** True when the b23.tv path is an opaque short code (not a direct BV id). */
export function needsB23Resolution(url: string): boolean {
  const parsed = parseB23TvUrl(url);
  if (!parsed) return false;
  return !parsed.shortCode.startsWith('BV');
}

function isAllowedBilibiliHost(hostname: string): boolean {
  const normalized = hostname.replace(/^www\./i, '').toLowerCase();
  return ALLOWED_BILIBILI_HOSTS.has(hostname.toLowerCase()) || normalized === 'bilibili.com';
}

/** Force www.bilibili.com host while preserving p/t query params. */
export function normalizeBilibiliUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (!isAllowedBilibiliHost(parsed.hostname)) {
      return url;
    }

    const params = new URLSearchParams();
    const p = parsed.searchParams.get('p');
    const t = parsed.searchParams.get('t');
    if (p) params.set('p', p);
    if (t) params.set('t', t);

    const query = params.toString();
    return `https://www.bilibili.com${parsed.pathname}${query ? `?${query}` : ''}`;
  } catch {
    return url;
  }
}

export async function resolveB23ShortUrl(url: string): Promise<string> {
  const parsed = parseB23TvUrl(url);
  if (!parsed) {
    throw new Error('Not a valid b23.tv short URL');
  }

  const apiUrl = `https://b23.wtf/api?full=${encodeURIComponent(parsed.apiInput)}&status=200`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), B23_RESOLVE_TIMEOUT_MS);

  try {
    const response = await fetch(apiUrl, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`b23.wtf responded with ${response.status}`);
    }

    const resolved = (await response.text()).trim();
    if (!resolved) {
      throw new Error('b23.wtf returned an empty URL');
    }

    let resolvedUrl: URL;
    try {
      resolvedUrl = new URL(resolved);
    } catch {
      throw new Error('b23.wtf returned an invalid URL');
    }

    if (!isAllowedBilibiliHost(resolvedUrl.hostname)) {
      throw new Error(`b23.wtf redirected to disallowed host: ${resolvedUrl.hostname}`);
    }

    return normalizeBilibiliUrl(resolved);
  } finally {
    clearTimeout(timeout);
  }
}

export interface ResolveSubmissionVideoUrlResult {
  url: string;
  resolved: boolean;
}

export async function resolveSubmissionVideoUrl(url: string): Promise<ResolveSubmissionVideoUrlResult> {
  const trimmed = url?.trim?.() ?? '';
  if (!trimmed) {
    return { url: '', resolved: false };
  }

  const parts = splitVideoLinks(trimmed);
  let resolved = false;
  const resolvedParts = await Promise.all(
    parts.map(async (part) => {
      if (needsB23Resolution(part)) {
        resolved = true;
        return resolveB23ShortUrl(part);
      }
      return cleanSingleVideoUrl(part);
    }),
  );

  return { url: resolvedParts.join(' '), resolved };
}

export async function applyResolvedVideoLinkToPayload(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const raw = typeof payload.videoLink === 'string' ? payload.videoLink : '';
  if (!raw.trim()) {
    return payload;
  }

  const { url } = await resolveSubmissionVideoUrl(raw);
  return { ...payload, videoLink: url };
}
