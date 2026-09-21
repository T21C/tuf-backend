import axios from 'axios';
import { logger } from '@/server/services/core/LoggerService.js';
import {
  extractYouTubeVideoId,
  getPrimaryVideoLink,
  getYouTubeEmbedUrl,
} from '@/misc/utils/data/videoLinkParts.js';
import type { VideoDetails } from '@/misc/utils/data/videoDetailTypes.js';

interface YouTubeResponse {
  items: Array<{
    snippet: {
      thumbnails: {
        maxres?: { url: string };
        high?: { url: string };
        medium?: { url: string };
        default?: { url: string };
      };
      channelId: string;
      title: string;
      channelTitle: string;
      publishedAt: string;
    };
  }>;
}

const CACHE_TTL_MS = 1000 * 60 * 60 * 24;
const NULL_TTL_MS = 1000 * 60 * 5;
const cache = new Map<string, { data: VideoDetails | null; expiresAt: number }>();

async function fetchYouTubeVideoDetails(url: string, videoId: string): Promise<VideoDetails | null> {
  const apiKey = process.env.YOUTUBE_API_KEY;
  const apiUrl = `https://www.googleapis.com/youtube/v3/videos?id=${videoId}&key=${apiKey}&part=snippet`;

  try {
    const response = await axios.get<YouTubeResponse>(apiUrl).catch(() => null);
    if (!response) return null;
    const data = response.data;
    if (!data.items?.length) return null;

    const snippet = data.items[0].snippet;
    return {
      title: snippet.title,
      channelName: snippet.channelTitle,
      timestamp: snippet.publishedAt,
      image:
        snippet.thumbnails?.maxres?.url ||
        snippet.thumbnails?.high?.url ||
        snippet.thumbnails?.medium?.url ||
        snippet.thumbnails?.default?.url,
      embed: getYouTubeEmbedUrl(url),
      channelId: snippet.channelId || null,
    };
  } catch (error) {
    logger.error(`Error fetching YouTube video details for link ${url}:`, error);
    return null;
  }
}

/** YouTube Data API metadata. Returns null for any non-YouTube URL without calling Google. */
export async function getYouTubeVideoDetails(url: string): Promise<VideoDetails | null> {
  const videoId = extractYouTubeVideoId(url);
  if (!videoId) return null;

  const cacheKey = getPrimaryVideoLink(url);
  const now = Date.now();
  const cached = cache.get(cacheKey);
  if (cached && now < cached.expiresAt) return cached.data;

  const details = await fetchYouTubeVideoDetails(url, videoId);
  cache.set(cacheKey, {
    data: details,
    expiresAt: now + (details ? CACHE_TTL_MS : NULL_TTL_MS),
  });
  return details;
}
