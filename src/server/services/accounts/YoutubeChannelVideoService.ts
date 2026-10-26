import axios from 'axios';
import UserYoutubeChannel from '@/models/auth/UserYoutubeChannel.js';
import UserYoutubeChannelCredential from '@/models/auth/UserYoutubeChannelCredential.js';
import {logger} from '@/server/services/core/LoggerService.js';
import {YoutubeChannelError} from '@/server/services/accounts/YouTubeChannelService.js';
import {
  clearYoutubeRefreshToken,
  readYoutubeRefreshToken,
  saveYoutubeRefreshToken,
} from '@/server/services/accounts/youtubeChannelCredentials.js';
import {
  forgetYoutubeChannelAccess,
  readYoutubeAccessToken,
  readYoutubePageCache,
  writeYoutubeAccessToken,
  writeYoutubePageCache,
  youtubePlaylistPageCacheKey,
} from '@/server/services/accounts/youtubeChannelAccessCache.js';
import {
  parseYoutubeUploadItems,
  youtubeUploadTitleMatches,
  youtubeUploadsPlaylistId,
  YOUTUBE_UPLOADS_MAX_SCAN_PAGES,
  YOUTUBE_UPLOADS_PAGE_SIZE,
  type YoutubeUploadVideo,
} from '@/misc/utils/data/youtubeUploads.js';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const YOUTUBE_PLAYLIST_ITEMS_URL = 'https://www.googleapis.com/youtube/v3/playlistItems';
const TOKEN_SKEW_MS = 60_000;

export interface YoutubeChannelVideoList {
  videos: YoutubeUploadVideo[];
  nextPageToken: string | null;
  canReadUnlisted: boolean;
}

interface PlaylistPage {
  items: YoutubeUploadVideo[];
  nextPageToken: string | null;
}

interface PlaylistItemsResponse {
  items?: unknown[];
  nextPageToken?: string;
}

interface GoogleRefreshResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  error?: string;
}

function isInvalidGrant(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false;
  const data = error.response?.data as {error?: unknown} | undefined;
  return data?.error === 'invalid_grant';
}

function youtubeListError(error: unknown): YoutubeChannelError {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const payload = JSON.stringify(error.response?.data ?? '');
    if (
      status === 403 &&
      (payload.includes('quotaExceeded') || payload.includes('dailyLimitExceeded'))
    ) {
      return new YoutubeChannelError(
        'YouTube video listing is temporarily unavailable',
        503,
        'YOUTUBE_QUOTA_EXCEEDED',
      );
    }
    if (status === 400 && payload.includes('pageToken')) {
      return new YoutubeChannelError(
        'YouTube page token is no longer valid',
        400,
        'YOUTUBE_PAGE_TOKEN_INVALID',
      );
    }
  }
  return new YoutubeChannelError(
    'Could not load YouTube videos',
    502,
    'YOUTUBE_VIDEOS_UNAVAILABLE',
  );
}

async function refreshAccessToken(
  channelRowId: number,
  channelId: string,
  refreshToken: string,
): Promise<string | null> {
  const cached = readYoutubeAccessToken(channelRowId);
  if (cached) return cached;

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  try {
    const response = await axios.post<GoogleRefreshResponse>(
      GOOGLE_TOKEN_URL,
      new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
      {headers: {'Content-Type': 'application/x-www-form-urlencoded'}},
    );
    const accessToken = response.data?.access_token?.trim() ?? '';
    if (!accessToken) return null;
    const rotated = response.data?.refresh_token?.trim();
    if (rotated) {
      await saveYoutubeRefreshToken(channelRowId, rotated);
    }
    const expiresIn = Number(response.data?.expires_in);
    const ttlMs = Number.isFinite(expiresIn) && expiresIn > 0
      ? Math.max(expiresIn * 1000 - TOKEN_SKEW_MS, 15_000)
      : 15 * 60 * 1000;
    writeYoutubeAccessToken(channelRowId, accessToken, Date.now() + ttlMs);
    return accessToken;
  } catch (error) {
    if (isInvalidGrant(error)) {
      await clearYoutubeRefreshToken(channelRowId);
      forgetYoutubeChannelAccess(channelRowId, channelId);
      logger.warn('youtube_refresh_token_revoked', {channelId});
      return null;
    }
    logger.warn('youtube_access_token_refresh_failed', {channelId});
    return null;
  }
}

async function fetchPlaylistPage(args: {
  channelId: string;
  playlistId: string;
  pageToken: string | null;
  accessToken: string | null;
}): Promise<PlaylistPage> {
  const owner = Boolean(args.accessToken);
  const cacheKey = youtubePlaylistPageCacheKey(args.channelId, owner, args.pageToken);
  const cached = readYoutubePageCache<PlaylistPage>(cacheKey);
  if (cached) return cached;

  const apiKey = process.env.YOUTUBE_API_KEY?.trim();
  if (!owner && !apiKey) {
    throw new YoutubeChannelError(
      'Could not load YouTube videos',
      503,
      'YOUTUBE_VIDEOS_UNAVAILABLE',
    );
  }

  try {
    const response = await axios.get<PlaylistItemsResponse>(YOUTUBE_PLAYLIST_ITEMS_URL, {
      params: {
        part: 'snippet,status',
        playlistId: args.playlistId,
        maxResults: YOUTUBE_UPLOADS_PAGE_SIZE,
        ...(args.pageToken ? {pageToken: args.pageToken} : {}),
        ...(!owner && apiKey ? {key: apiKey} : {}),
      },
      headers: owner ? {Authorization: `Bearer ${args.accessToken}`} : undefined,
    });
    const page: PlaylistPage = {
      items: parseYoutubeUploadItems(response.data?.items),
      nextPageToken: response.data?.nextPageToken?.trim() || null,
    };
    writeYoutubePageCache(cacheKey, page);
    return page;
  } catch (error) {
    if (error instanceof YoutubeChannelError) throw error;
    throw youtubeListError(error);
  }
}

class YoutubeChannelVideoService {
  async listForUser(args: {
    userId: string;
    channelId: string;
    query: string;
    pageToken: string | null;
  }): Promise<YoutubeChannelVideoList> {
    const channelId = args.channelId.trim();
    const channel = await UserYoutubeChannel.findOne({
      where: {userId: args.userId, channelId},
    });
    if (!channel) {
      throw new YoutubeChannelError(
        'YouTube channel is not linked',
        404,
        'YOUTUBE_CHANNEL_NOT_FOUND',
      );
    }

    const playlistId = youtubeUploadsPlaylistId(channel.channelId);
    if (!playlistId) {
      throw new YoutubeChannelError(
        'This YouTube channel cannot be listed',
        400,
        'YOUTUBE_UPLOADS_PLAYLIST_UNKNOWN',
      );
    }

    const credential = await UserYoutubeChannelCredential.findByPk(channel.id, {
      attributes: ['userYoutubeChannelId'],
    });
    let accessToken: string | null = null;
    let canReadUnlisted = false;
    if (credential) {
      const refreshToken = await readYoutubeRefreshToken(channel.id);
      if (refreshToken) {
        accessToken = await refreshAccessToken(channel.id, channel.channelId, refreshToken);
        const stillStored = await UserYoutubeChannelCredential.findByPk(channel.id, {
          attributes: ['userYoutubeChannelId'],
        });
        canReadUnlisted = Boolean(stillStored);
      }
    }

    const query = args.query.trim();
    const maxPages = query ? YOUTUBE_UPLOADS_MAX_SCAN_PAGES : 1;
    const videos: YoutubeUploadVideo[] = [];
    let pageToken = args.pageToken;
    let nextPageToken: string | null = null;

    for (let page = 0; page < maxPages; page += 1) {
      const loaded = await fetchPlaylistPage({
        channelId: channel.channelId,
        playlistId,
        pageToken,
        accessToken,
      });
      nextPageToken = loaded.nextPageToken;
      const matched = query
        ? loaded.items.filter((video) => youtubeUploadTitleMatches(video.title, query))
        : loaded.items;
      videos.push(...matched);
      if (!loaded.nextPageToken || (query && videos.length > 0)) break;
      pageToken = loaded.nextPageToken;
    }

    return {videos, nextPageToken, canReadUnlisted};
  }
}

export const youtubeChannelVideoService = new YoutubeChannelVideoService();
export default youtubeChannelVideoService;
