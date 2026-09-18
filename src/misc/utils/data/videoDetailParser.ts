import twemoji from 'twemoji';
import axios from 'axios';
import { logger } from '@/server/services/core/LoggerService.js';
import {
  extractYouTubeVideoId,
  getPrimaryVideoLink,
  getYouTubeEmbedUrl,
} from '@/misc/utils/data/videoLinkParts.js';

export interface VideoDetails {
  title: string;
  channelName: string;
  timestamp: string;
  image: string | undefined;
  embed: string | null;
  channelId?: string | null;
}

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

interface YouTubeResponse {
  items: Array<{
    snippet: {
      thumbnails: {
        maxres: {
          url: string;
          width: number;
          height: number;
        };
        high: {
          url: string;
          width: number;
          height: number;
        };
        medium: {
          url: string;
          width: number;
          height: number;
        };
        default: {
          url: string;
          width: number;
          height: number;
        };
      };
      channelId: string;
      title: string;
      channelTitle: string;
      publishedAt: string;
      description: string;
    };
  }>;
}

const ownUrlEnv =
  process.env.NODE_ENV === 'production'
    ? process.env.PROD_API_URL
    : process.env.NODE_ENV === 'staging'
      ? process.env.STAGING_API_URL
      : process.env.NODE_ENV === 'development'
        ? process.env.DEV_URL
        : 'http://localhost:3002';

function getBilibiliEmbedUrlFromData(data: BilibiliData): string | null {
  const {aid, bvid, cid} = data;

  if (bvid) {
    return `//player.bilibili.com/player.html?isOutside=true&aid=${aid}&bvid=${bvid}&cid=${cid}&p=1&autoplay=0`;
  }
  return null;
}

async function getBilibiliVideoDetails(
  url: string,
): Promise<VideoDetails | null> {
  const urlRegex =
    /https?:\/\/(www\.)?bilibili\.com\/video\/(BV[a-zA-Z0-9]+)\/?/;
  const match = url.match(urlRegex);
  const videoId = match ? match[2] : null;

  if (!videoId) {
    return null;
  }

  const IMAGE_API = `${ownUrlEnv}${process.env.IMAGE_API}`;
  const BILIBILI_API = 'https://api.bilibili.com/x/web-interface/view';

  try {
    const response = await axios.get<{data: BilibiliData}>(`${BILIBILI_API}?bvid=${videoId}`);
    if (response.status !== 200) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }

    const {data} = response.data;
    const unix = data.pubdate;
    const date = new Date(unix * 1000);
    const imageUrl = `${IMAGE_API}?url=${encodeURIComponent(data.pic)}`;

    return {
      title: data.title,
      channelName: data.owner.name,
      timestamp: date.toISOString(),
      image: imageUrl,
      embed: getBilibiliEmbedUrlFromData(data),
      channelId: null,
    };
  } catch (error) {
    logger.debug(`Error fetching Bilibili video details for link ${url}:`, error);
    return null;
  }
}

async function getYouTubeVideoDetails(
  url: string,
): Promise<VideoDetails | null> {
  const videoId = extractYouTubeVideoId(url);

  if (!videoId) {
    return null;
  }

  const apiKey = process.env.YOUTUBE_API_KEY;
  const apiUrl = `https://www.googleapis.com/youtube/v3/videos?id=${videoId}&key=${apiKey}&part=snippet`;

  try {
    const response = await axios.get<YouTubeResponse>(apiUrl).catch(() => {
      return null;
    });
    if (!response) {
      return null;
    }
    const data = response.data;
    if (!data.items?.length) {
      return null;
    }

    return {
      title: data.items[0].snippet.title,
      channelName: data.items[0].snippet.channelTitle,
      timestamp: data.items[0].snippet.publishedAt,
      image:
        data.items[0].snippet.thumbnails?.maxres?.url ||
        data.items[0].snippet.thumbnails?.high?.url ||
        data.items[0].snippet.thumbnails?.medium?.url ||
        data.items[0].snippet.thumbnails?.default?.url,
      embed: getYouTubeEmbedUrl(url),
      channelId: data.items[0].snippet.channelId || null,
    };
  } catch (error) {
    logger.error(`Error fetching YouTube video details for link ${url}:`, error);
    return null;
  }
}

const VIDEO_CACHE_TTL_MS = 1000 * 60 * 60 * 24;
const VIDEO_CACHE_NULL_TTL_MS = 1000 * 60 * 5;
const videoDetailsCache = new Map<string, {data: VideoDetails | null; expiresAt: number}>();

async function getVideoDetails(url: string): Promise<VideoDetails | null> {
  const primary = getPrimaryVideoLink(url);
  if (!primary) {
    return null;
  }

  const now = Date.now();
  const cached = videoDetailsCache.get(primary);
  if (cached && now < cached.expiresAt) {
    return cached.data;
  }

  const details = await getYouTubeVideoDetails(primary);
  const resolved = details ?? (await getBilibiliVideoDetails(primary));
  videoDetailsCache.set(primary, {
    data: resolved,
    expiresAt: now + (resolved ? VIDEO_CACHE_TTL_MS : VIDEO_CACHE_NULL_TTL_MS),
  });
  return resolved;
}

function isoToEmoji(code: string): string | null {
  const htmlString = twemoji.parse(
    code
      .toLowerCase()
      .split('')
      .map((letter: string) => (letter.charCodeAt(0) % 32) + 0x1f1e5)
      .map((n: number) => String.fromCodePoint(n))
      .join(''),
  );

  const srcRegex = /src\s*=\s*"(.+?)"/;
  const match = htmlString.match(srcRegex);

  return match ? match[1] : null;
}

export {
  getYouTubeVideoDetails,
  getBilibiliVideoDetails,
  isoToEmoji,
  getVideoDetails,
};
