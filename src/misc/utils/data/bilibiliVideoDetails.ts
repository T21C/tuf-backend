import axios from 'axios';
import { logger } from '@/server/services/core/LoggerService.js';
import { extractBilibiliBvId } from '@/misc/utils/data/videoLinkParts.js';
import type { VideoDetails } from '@/misc/utils/data/videoDetailTypes.js';

interface BilibiliData {
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
}

export const BILIBILI_REQUEST_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Referer: 'https://www.bilibili.com/',
  Origin: 'https://www.bilibili.com',
};

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

function normalizePicUrl(pic: string): string | null {
  const trimmed = pic.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('//')) return `https:${trimmed}`;
  if (trimmed.startsWith('http://')) return `https://${trimmed.slice('http://'.length)}`;
  if (trimmed.startsWith('https://')) return trimmed;
  return null;
}

/** Archive stills only, e.g. i0.hdslb.com/bfs/archive/<hash>.jpg */
function isArchiveCover(pic: string): boolean {
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

function embedFromView(data: BilibiliData): string | null {
  if (!data.bvid) return null;
  return `https://player.bilibili.com/player.html?isOutside=true&aid=${data.aid}&bvid=${data.bvid}&cid=${data.cid}&p=1&autoplay=0`;
}

function publicCoverUrl(bvid: string): string {
  const base = (ownUrlEnv || '').replace(/\/$/, '');
  return `${base}/v2/media/bilibili-cover?bvid=${encodeURIComponent(bvid)}`;
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

/** Cover and metadata from the public video page (`videoData.pic` / og:image). */
async function loadViewFromPage(bvid: string): Promise<BilibiliData | null> {
  try {
    const response = await axios.get<string>(
      `https://www.bilibili.com/video/${encodeURIComponent(bvid)}/`,
      {
        headers: {
          ...BILIBILI_REQUEST_HEADERS,
          Accept: 'text/html,application/xhtml+xml',
        },
        timeout: 10000,
        responseType: 'text',
        validateStatus: (status) => status >= 200 && status < 300,
      },
    );
    const html = response.data;
    if (typeof html !== 'string') return null;

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
  } catch (error) {
    logger.debug(`Bilibili video page failed for ${bvid}:`, error);
    return null;
  }
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
    logger.debug(`Error fetching Bilibili video details for link ${url}:`, error);
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

  try {
    const response = await axios.get<ArrayBuffer>(pic, {
      responseType: 'arraybuffer',
      timeout: 10000,
      maxContentLength: 10 * 1024 * 1024,
      maxBodyLength: 10 * 1024 * 1024,
      headers: BILIBILI_REQUEST_HEADERS,
      validateStatus: (status) => status >= 200 && status < 300,
    });
    const contentType = String(response.headers['content-type'] || '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (!contentType.startsWith('image/')) return null;
    return { buffer: Buffer.from(response.data), contentType };
  } catch (error) {
    logger.debug(`Error downloading Bilibili cover for ${bvid}:`, error);
    return null;
  }
}
