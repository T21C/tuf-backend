import axios from 'axios';
import { logger } from '@/server/services/core/LoggerService.js';
import { extractBilibiliBvId } from '@/misc/utils/data/videoLinkParts.js';
import type { VideoDetails } from '@/misc/utils/data/videoDetailTypes.js';
import { BILIBILI_REQUEST_HEADERS } from '@/externalServices/bilibiliProxy/helpers.js';

export { BILIBILI_REQUEST_HEADERS };

const BVID_PATTERN = /^BV[a-zA-Z0-9]+$/;
const REQUEST_TIMEOUT_MS = 30_000;

const ownUrlEnv =
  process.env.NODE_ENV === 'production'
    ? process.env.PROD_API_URL
    : process.env.NODE_ENV === 'staging'
      ? process.env.STAGING_API_URL
      : process.env.NODE_ENV === 'development'
        ? process.env.DEV_URL
        : 'http://localhost:3002';

function proxyBaseUrl(): string {
  return (process.env.LOCAL_BILIBILI_PROXY_URL || 'http://127.0.0.1:3892').replace(/\/$/, '');
}

function publicCoverUrl(bvid: string): string {
  const base = (ownUrlEnv || '').replace(/\/$/, '');
  return `${base}/v2/media/bilibili-cover?bvid=${encodeURIComponent(bvid)}`;
}

interface ProxyVideoDetails {
  title: string;
  channelName: string;
  timestamp: string;
  embed: string | null;
}

function toVideoDetails(bvid: string, data: ProxyVideoDetails): VideoDetails {
  return {
    title: data.title,
    channelName: data.channelName,
    timestamp: data.timestamp,
    image: publicCoverUrl(bvid),
    embed: data.embed,
    channelId: null,
  };
}

/** Bilibili view metadata. Returns null for any non-Bilibili URL without calling Bilibili. */
export async function getBilibiliVideoDetails(url: string): Promise<VideoDetails | null> {
  const bvid = extractBilibiliBvId(url);
  if (!bvid) return null;
  try {
    const response = await axios.get<ProxyVideoDetails>(`${proxyBaseUrl()}/video-details`, {
      params: { bvid },
      timeout: REQUEST_TIMEOUT_MS,
      validateStatus: (status) => status === 200 || status === 404,
      proxy: false,
    });
    if (response.status === 404 || !response.data) return null;
    return toVideoDetails(bvid, response.data);
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
  if (!BVID_PATTERN.test(bvid)) return null;
  try {
    const response = await axios.get<ArrayBuffer>(`${proxyBaseUrl()}/cover`, {
      params: { bvid },
      timeout: REQUEST_TIMEOUT_MS,
      responseType: 'arraybuffer',
      validateStatus: (status) => status === 200 || status === 404,
      proxy: false,
    });
    if (response.status === 404) return null;
    const contentType = String(response.headers['content-type'] || '')
      .split(';')[0]
      .trim()
      .toLowerCase() || 'image/jpeg';
    const buffer = Buffer.from(response.data);
    if (buffer.length === 0) return null;
    return { buffer, contentType };
  } catch (error) {
    logger.warn(`Error downloading Bilibili cover for ${bvid}:`, error);
    return null;
  }
}
