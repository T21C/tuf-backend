import { logger } from '@/server/services/core/LoggerService.js';
import {
  isArchiveCover,
  normalizePicUrl,
  parseBilibiliViewHtml,
  resolveBilibiliFetchMode,
  type BilibiliViewData,
} from './helpers.js';
import { fetchBilibiliHtml, fetchBilibiliImage } from './axios.js';
import { getHealthyCount } from './pool.js';
import { raceProxyWaves } from './waves.js';
import { BilibiliProxyCronService } from './cron.js';

export const BVID_PATTERN = /^BV[a-zA-Z0-9]+$/;

export interface BilibiliVideoDetailsPayload {
  title: string;
  channelName: string;
  timestamp: string;
  embed: string | null;
}

const VIEW_CACHE_TTL_MS = 1000 * 60 * 60 * 24;
const VIEW_NULL_TTL_MS = 1000 * 60 * 5;
const viewCache = new Map<string, { data: BilibiliViewData | null; expiresAt: number }>();

function embedFromView(data: BilibiliViewData): string | null {
  if (!data.bvid) return null;
  return `https://player.bilibili.com/player.html?isOutside=true&aid=${data.aid}&bvid=${data.bvid}&cid=${data.cid}&p=1&autoplay=0`;
}

async function fetchMode() {
  const disabled = process.env.BILIBILI_PROXY_DISABLED === '1';
  const nodeEnv = process.env.NODE_ENV;
  if (disabled || (nodeEnv !== 'production' && nodeEnv !== 'staging')) {
    return resolveBilibiliFetchMode({ nodeEnv, disabled, healthyCount: 0 });
  }
  const healthyCount = await getHealthyCount();
  BilibiliProxyCronService.requestListRefreshIfDry(healthyCount);
  return resolveBilibiliFetchMode({
    nodeEnv,
    disabled,
    healthyCount,
  });
}

async function loadViewFromPage(bvid: string): Promise<BilibiliViewData | null> {
  const mode = await fetchMode();
  if (mode === 'fail_closed') {
    logger.warn(`Bilibili proxy pool empty; fail closed for ${bvid}`);
    return null;
  }

  if (mode === 'direct') {
    const result = await fetchBilibiliHtml(bvid, { proxy: null, timeoutMs: 10000 });
    if ('reason' in result) return null;
    return parseBilibiliViewHtml(bvid, result.html);
  }

  const won = await raceProxyWaves<BilibiliViewData>(
    async (proxy, signal) => {
      const result = await fetchBilibiliHtml(bvid, { proxy, signal });
      if ('reason' in result) return result;
      const parsed = parseBilibiliViewHtml(bvid, result.html);
      if (!parsed) return { reason: 'no_meta' as const, proxyOk: true };
      return { value: parsed };
    },
    { logLabel: `html ${bvid}` },
  );

  if (!won) return null;

  won.value.viaProxyId = won.proxy.id;
  return won.value;
}

async function loadView(bvid: string): Promise<BilibiliViewData | null> {
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

function toDetails(data: BilibiliViewData): BilibiliVideoDetailsPayload | null {
  const pic = normalizePicUrl(data.pic);
  if (!pic || !isArchiveCover(pic) || !data.bvid) return null;
  const date = new Date(Number(data.pubdate) * 1000);
  if (Number.isNaN(date.getTime())) return null;
  return {
    title: data.title,
    channelName: data.owner?.name || '',
    timestamp: date.toISOString(),
    embed: embedFromView(data),
  };
}

export async function getBilibiliVideoDetailsByBvid(
  bvid: string,
): Promise<BilibiliVideoDetailsPayload | null> {
  if (!BVID_PATTERN.test(bvid)) return null;
  try {
    const data = await loadView(bvid);
    if (!data) return null;
    return toDetails(data);
  } catch (error) {
    logger.warn(`Error fetching Bilibili video details for ${bvid}:`, error);
    return null;
  }
}

export async function downloadBilibiliCoverByBvid(
  bvid: string,
): Promise<{ buffer: Buffer; contentType: string } | null> {
  if (!BVID_PATTERN.test(bvid)) return null;
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
    { preferredId: data?.viaProxyId ?? null, logLabel: `cover ${bvid}`, skipCoverLosers: true },
  );

  if (!won) {
    logger.warn(`Error downloading Bilibili cover for ${bvid}: all proxy waves empty`);
    return null;
  }
  return won.value;
}
