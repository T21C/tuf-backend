import { logger } from '@/server/services/core/LoggerService.js';
import { extractBilibiliBvId } from '@/misc/utils/data/videoLinkParts.js';
import type { VideoDetails } from '@/misc/utils/data/videoDetailTypes.js';
import {
  BILIBILI_REQUEST_HEADERS,
  isArchiveCover,
  normalizePicUrl,
  parseBilibiliViewHtml,
  resolveBilibiliFetchMode,
  type BilibiliViewData,
} from '@/misc/utils/data/bilibiliProxy.js';
import {
  fetchBilibiliHtml,
  fetchBilibiliImage,
} from '@/misc/utils/data/bilibiliProxyAxios.js';
import { getHealthyCount } from '@/server/services/media/bilibiliProxyPool.js';
import { raceProxyWaves } from '@/server/services/media/bilibiliProxyWaves.js';

export { BILIBILI_REQUEST_HEADERS };

type BilibiliData = BilibiliViewData;

const VIEW_CACHE_TTL_MS = 1000 * 60 * 60 * 24;
const VIEW_NULL_TTL_MS = 1000 * 60 * 5;
const viewCache = new Map<string, { data: BilibiliData | null; expiresAt: number }>();

const ownUrlEnv =
  process.env.NODE_ENV === 'production'
    ? process.env.PROD_API_URL
    : process.env.NODE_ENV === 'staging'
      ? process.env.STAGING_API_URL
      : process.env.NODE_ENV === 'development'
        ? process.env.DEV_URL
        : 'http://localhost:3002';

function embedFromView(data: BilibiliData): string | null {
  if (!data.bvid) return null;
  return `https://player.bilibili.com/player.html?isOutside=true&aid=${data.aid}&bvid=${data.bvid}&cid=${data.cid}&p=1&autoplay=0`;
}

function publicCoverUrl(bvid: string): string {
  const base = (ownUrlEnv || '').replace(/\/$/, '');
  return `${base}/v2/media/bilibili-cover?bvid=${encodeURIComponent(bvid)}`;
}

async function fetchMode() {
  const disabled = process.env.BILIBILI_PROXY_DISABLED === '1';
  const nodeEnv = process.env.NODE_ENV;
  if (disabled || (nodeEnv !== 'production' && nodeEnv !== 'staging')) {
    return resolveBilibiliFetchMode({ nodeEnv, disabled, healthyCount: 0 });
  }
  return resolveBilibiliFetchMode({
    nodeEnv,
    disabled,
    healthyCount: await getHealthyCount(),
  });
}

async function loadViewFromPage(bvid: string): Promise<BilibiliData | null> {
  const mode = await fetchMode();
  if (mode === 'fail_closed') {
    logger.warn(`Bilibili proxy pool empty; fail closed for ${bvid}`);
    return null;
  }

  if (mode === 'direct') {
    const result = await fetchBilibiliHtml(bvid, { proxy: null, timeoutMs: 10000 });
    if ('reason' in result) {
      logger.warn(`Bilibili video page failed for ${bvid}: ${result.reason}`);
      return null;
    }
    return parseBilibiliViewHtml(bvid, result.html);
  }

  const won = await raceProxyWaves<BilibiliData>(
    async (proxy, signal) => {
      const result = await fetchBilibiliHtml(bvid, { proxy, signal });
      if ('reason' in result) return result;
      const parsed = parseBilibiliViewHtml(bvid, result.html);
      if (!parsed) return { reason: 'no_meta' as const, proxyOk: true };
      return { value: parsed };
    },
    { logLabel: `html ${bvid}` },
  );

  if (!won) {
    logger.warn(`Bilibili video page failed for ${bvid}: all proxy waves empty`);
    return null;
  }

  won.value.viaProxyId = won.proxy.id;
  return won.value;
}

async function loadView(bvid: string): Promise<BilibiliData | null> {
  const now = Date.now();
  const cached = viewCache.get(bvid);
  if (cached && now < cached.expiresAt) return cached.data;

  const data = await loadViewFromPage(bvid);
  viewCache.set(bvid, {
    data,
    expiresAt: now + (data ? VIEW_CACHE_TTL_MS : VIEW_NULL_TTL_MS),
  });
  return data;
}

function toDetails(data: BilibiliData): VideoDetails | null {
  const pic = normalizePicUrl(data.pic);
  if (!pic || !isArchiveCover(pic) || !data.bvid) return null;
  const date = new Date(Number(data.pubdate) * 1000);
  if (Number.isNaN(date.getTime())) return null;
  return {
    title: data.title,
    channelName: data.owner?.name || '',
    timestamp: date.toISOString(),
    image: publicCoverUrl(data.bvid),
    embed: embedFromView(data),
    channelId: null,
  };
}

/** Bilibili view metadata. Returns null for any non-Bilibili URL without calling Bilibili. */
export async function getBilibiliVideoDetails(url: string): Promise<VideoDetails | null> {
  const bvid = extractBilibiliBvId(url);
  if (!bvid) return null;
  try {
    const data = await loadView(bvid);
    if (!data) return null;
    return toDetails(data);
  } catch (error) {
    logger.warn(`Error fetching Bilibili video details for link ${url}:`, error);
    return null;
  }
}

/** Raw cover bytes for thumbnail rendering. Does not go through the YouTube thumbnail helper. */
export async function downloadBilibiliCover(url: string): Promise<Buffer | null> {
  const bvid = extractBilibiliBvId(url);
  if (!bvid) return null;
  const cover = await downloadBilibiliCoverByBvid(bvid);
  return cover?.buffer ?? null;
}

export async function downloadBilibiliCoverByBvid(
  bvid: string,
): Promise<{ buffer: Buffer; contentType: string } | null> {
  if (!/^BV[a-zA-Z0-9]+$/.test(bvid)) return null;
  const data = await loadView(bvid);
  const pic = data?.pic ? normalizePicUrl(data.pic) : null;
  if (!pic || !isArchiveCover(pic)) return null;

  const mode = await fetchMode();
  if (mode === 'fail_closed') {
    logger.warn(`Bilibili proxy pool empty; fail closed cover for ${bvid}`);
    return null;
  }

  if (mode === 'direct') {
    const result = await fetchBilibiliImage(pic, { proxy: null, timeoutMs: 10000 });
    if ('reason' in result) {
      logger.warn(`Error downloading Bilibili cover for ${bvid}: ${result.reason}`);
      return null;
    }
    return result;
  }

  const won = await raceProxyWaves<{ buffer: Buffer; contentType: string }>(
    async (proxy, signal) => {
      const result = await fetchBilibiliImage(pic, { proxy, signal });
      if ('reason' in result) return result;
      return { value: result };
    },
    { preferredId: data?.viaProxyId ?? null, logLabel: `cover ${bvid}` },
  );

  if (!won) {
    logger.warn(`Error downloading Bilibili cover for ${bvid}: all proxy waves empty`);
    return null;
  }
  return won.value;
}
