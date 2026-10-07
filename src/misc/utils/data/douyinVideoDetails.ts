import axios from 'axios';
import { logger } from '@/server/services/core/LoggerService.js';
import {
  DOUYIN_AWEME_ID_PATTERN,
  extractDouyinAwemeId,
  getDouyinEmbedUrl,
} from '@/misc/utils/data/videoLinkParts.js';
import type { VideoDetails } from '@/misc/utils/data/videoDetailTypes.js';

const REQUEST_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 1000 * 60 * 60 * 24;
const NULL_TTL_MS = 1000 * 60 * 5;
const COVER_MAX_REDIRECTS = 3;
const DOUYIN_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const ownUrlEnv =
  process.env.NODE_ENV === 'production'
    ? process.env.PROD_API_URL
    : process.env.NODE_ENV === 'staging'
      ? process.env.STAGING_API_URL
      : process.env.NODE_ENV === 'development'
        ? process.env.DEV_URL
        : 'http://localhost:3002';

interface DouyinCoverList {
  url_list?: unknown;
}

interface DouyinAwemeDetail {
  desc?: unknown;
  create_time?: unknown;
  author?: { nickname?: unknown } | null;
  video?: {
    origin_cover?: DouyinCoverList | null;
    cover?: DouyinCoverList | null;
  } | null;
}

interface DouyinDetailResponse {
  aweme_detail?: DouyinAwemeDetail | null;
}

interface DouyinView {
  title: string;
  channelName: string;
  timestamp: string;
  coverUrl: string | null;
}

const cache = new Map<string, { data: DouyinView | null; expiresAt: number }>();
const inflight = new Map<string, Promise<DouyinView | null>>();

function publicCoverUrl(awemeId: string): string {
  const base = (ownUrlEnv || '').replace(/\/$/, '');
  return `${base}/v2/media/douyin-cover?awemeId=${encodeURIComponent(awemeId)}`;
}

function playerReferer(awemeId: string): string {
  return `https://open.douyin.com/player/video?vid=${awemeId}`;
}

function isAllowedDouyinPicUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    return host === 'douyinpic.com' || host.endsWith('.douyinpic.com');
  } catch {
    return false;
  }
}

function firstDouyinPicUrl(cover: DouyinCoverList | null | undefined): string | null {
  const list = cover?.url_list;
  if (!Array.isArray(list)) return null;
  for (const entry of list) {
    if (typeof entry !== 'string') continue;
    if (isAllowedDouyinPicUrl(entry)) return entry;
  }
  return null;
}

function toView(detail: DouyinAwemeDetail): DouyinView {
  const createTime = Number(detail.create_time);
  const date = new Date(createTime * 1000);
  const timestamp = Number.isFinite(createTime) && !Number.isNaN(date.getTime()) ? date.toISOString() : '';
  return {
    title: typeof detail.desc === 'string' ? detail.desc : '',
    channelName: typeof detail.author?.nickname === 'string' ? detail.author.nickname : '',
    timestamp,
    coverUrl: firstDouyinPicUrl(detail.video?.origin_cover) || firstDouyinPicUrl(detail.video?.cover),
  };
}

function toVideoDetails(awemeId: string, view: DouyinView): VideoDetails {
  return {
    title: view.title,
    channelName: view.channelName,
    timestamp: view.timestamp,
    image: publicCoverUrl(awemeId),
    embed: getDouyinEmbedUrl(`https://www.douyin.com/video/${awemeId}`),
    channelId: null,
  };
}

async function fetchDouyinView(awemeId: string): Promise<DouyinView | null> {
  try {
    const response = await axios.get<DouyinDetailResponse>(
      'https://www.douyin.com/aweme/v1/web/aweme/detail/',
      {
        params: { aweme_id: awemeId, aid: 6383 },
        timeout: REQUEST_TIMEOUT_MS,
        proxy: false,
        validateStatus: (status) => status === 200,
        headers: {
          'User-Agent': DOUYIN_UA,
          Accept: 'application/json',
          Referer: playerReferer(awemeId),
          Origin: 'https://open.douyin.com',
        },
      },
    );
    const detail = response.data?.aweme_detail;
    if (!detail || typeof detail !== 'object') return null;
    return toView(detail);
  } catch (error) {
    logger.warn(`Error fetching Douyin video details for ${awemeId}:`, error instanceof Error ? error.message : error);
    return null;
  }
}

async function loadView(awemeId: string, { bypassCache = false } = {}): Promise<DouyinView | null> {
  if (!DOUYIN_AWEME_ID_PATTERN.test(awemeId)) return null;

  const now = Date.now();
  if (!bypassCache) {
    const cached = cache.get(awemeId);
    if (cached && now < cached.expiresAt) return cached.data;
    const pending = inflight.get(awemeId);
    if (pending) return pending;
  }

  const promise = fetchDouyinView(awemeId).then((data) => {
    cache.set(awemeId, {
      data,
      expiresAt: now + (data ? CACHE_TTL_MS : NULL_TTL_MS),
    });
    return data;
  }).finally(() => {
    inflight.delete(awemeId);
  });

  inflight.set(awemeId, promise);
  return promise;
}

async function downloadHttpsDouyinPic(
  url: string,
  hops = 0,
): Promise<{ buffer: Buffer; contentType: string } | null> {
  if (hops > COVER_MAX_REDIRECTS) return null;
  if (!isAllowedDouyinPicUrl(url)) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        'User-Agent': DOUYIN_UA,
        Accept: 'image/avif,image/webp,image/*,*/*;q=0.8',
      },
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return null;
      return downloadHttpsDouyinPic(new URL(location, url).href, hops + 1);
    }

    if (response.status !== 200) return null;
    const contentType = (response.headers.get('content-type') || 'image/jpeg')
      .split(';')[0]
      .trim()
      .toLowerCase() || 'image/jpeg';
    if (!contentType.startsWith('image/')) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) return null;
    return { buffer, contentType };
  } catch (error) {
    logger.warn(`Error downloading Douyin cover:`, error instanceof Error ? error.message : error);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** Douyin player-detail metadata. Returns null for any non-Douyin URL without calling Douyin. */
export async function getDouyinVideoDetails(url: string): Promise<VideoDetails | null> {
  const awemeId = extractDouyinAwemeId(url);
  if (!awemeId) return null;
  const view = await loadView(awemeId);
  if (!view) return null;
  return toVideoDetails(awemeId, view);
}

/** Raw cover bytes for thumbnail rendering. Does not go through the YouTube thumbnail helper. */
export async function downloadDouyinCover(url: string): Promise<Buffer | null> {
  const awemeId = extractDouyinAwemeId(url);
  if (!awemeId) return null;
  const cover = await downloadDouyinCoverByAwemeId(awemeId);
  return cover?.buffer ?? null;
}

export async function downloadDouyinCoverByAwemeId(
  awemeId: string,
): Promise<{ buffer: Buffer; contentType: string } | null> {
  if (!DOUYIN_AWEME_ID_PATTERN.test(awemeId)) return null;

  const tryDownload = async (bypassCache: boolean) => {
    const view = await loadView(awemeId, { bypassCache });
    if (!view?.coverUrl) return null;
    return downloadHttpsDouyinPic(view.coverUrl);
  };

  const first = await tryDownload(false);
  if (first) return first;
  cache.delete(awemeId);
  return tryDownload(true);
}
