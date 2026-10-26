const PAGE_TTL_MS = 3 * 60 * 1000;
const MAX_ENTRIES = 400;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const pages = new Map<string, CacheEntry<unknown>>();
const accessTokens = new Map<number, CacheEntry<string>>();

function readFresh<K, T>(map: Map<K, CacheEntry<T>>, key: K): T | undefined {
  const hit = map.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt <= Date.now()) {
    map.delete(key);
    return undefined;
  }
  return hit.value;
}

function pruneExpired<K, T>(map: Map<K, CacheEntry<T>>): void {
  if (map.size < MAX_ENTRIES) return;
  const now = Date.now();
  for (const [key, entry] of map) {
    if (entry.expiresAt <= now) map.delete(key);
  }
}

export function youtubePlaylistPageCacheKey(
  channelId: string,
  owner: boolean,
  pageToken: string | null,
): string {
  return `${channelId}|${owner ? 'owner' : 'public'}|${pageToken ?? ''}`;
}

export function readYoutubePageCache<T>(key: string): T | undefined {
  return readFresh(pages, key) as T | undefined;
}

export function writeYoutubePageCache<T>(key: string, value: T): void {
  pruneExpired(pages);
  pages.set(key, {value, expiresAt: Date.now() + PAGE_TTL_MS});
}

export function readYoutubeAccessToken(channelRowId: number): string | undefined {
  return readFresh(accessTokens, channelRowId);
}

export function writeYoutubeAccessToken(
  channelRowId: number,
  accessToken: string,
  expiresAt: number,
): void {
  pruneExpired(accessTokens);
  accessTokens.set(channelRowId, {value: accessToken, expiresAt});
}

export function forgetYoutubeChannelAccess(channelRowId: number, channelId: string): void {
  accessTokens.delete(channelRowId);
  const prefix = `${channelId}|`;
  for (const key of pages.keys()) {
    if (key.startsWith(prefix)) pages.delete(key);
  }
}
