import axios from 'axios';
import {normalizeYoutubeHandle} from '@/misc/utils/data/youtubeChannel.js';
import {
  OAuthYoutubeApiDisabledError,
  OAuthYoutubeChannelRequiredError,
  type NormalizedOAuthProfile,
  type OAuthProviderAdapter,
} from './types.js';

const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const YOUTUBE_CHANNELS_URL = 'https://www.googleapis.com/youtube/v3/channels';
export const YOUTUBE_OAUTH_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';

interface GoogleTokenResponse {
  access_token?: string;
}

interface YoutubeChannelsListResponse {
  items?: Array<{
    id?: string;
    snippet?: {
      title?: string;
      customUrl?: string;
    };
  }>;
}

export function buildYouTubeAuthorizeUrl(
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: YOUTUBE_OAUTH_SCOPE,
    state,
    prompt: 'select_account consent',
  });
  return `${GOOGLE_AUTHORIZE_URL}?${params.toString()}`;
}

function isYoutubeDataApiDisabled(error: unknown): boolean {
  if (!axios.isAxiosError(error) || error.response?.status !== 403) return false;
  const payload = JSON.stringify(error.response.data ?? '');
  return (
    payload.includes('accessNotConfigured') ||
    payload.includes('SERVICE_DISABLED') ||
    payload.includes('youtube.googleapis.com')
  );
}

export function parseYoutubeMineChannelList(
  data: YoutubeChannelsListResponse | null | undefined,
): {id: string; title: string; handle: string | null} {
  const item = data?.items?.[0];
  const id = typeof item?.id === 'string' ? item.id.trim() : '';
  if (!id) {
    throw new OAuthYoutubeChannelRequiredError();
  }
  const title =
    typeof item?.snippet?.title === 'string' ? item.snippet.title.trim() : '';
  return {
    id,
    title,
    handle: normalizeYoutubeHandle(item?.snippet?.customUrl),
  };
}

export const youtubeOAuthProvider: OAuthProviderAdapter = {
  id: 'youtube',
  linkOnly: true,

  buildAuthorizeUrl({redirectUri, state}) {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) {
      throw new Error('GOOGLE_CLIENT_ID is not set');
    }
    return buildYouTubeAuthorizeUrl(clientId, redirectUri, state);
  },

  async exchangeCode({code, redirectUri}): Promise<NormalizedOAuthProfile | null> {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      return null;
    }
    try {
      const tokenResponse = await axios.post(
        GOOGLE_TOKEN_URL,
        new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri,
        }),
        {
          headers: {'Content-Type': 'application/x-www-form-urlencoded'},
        },
      );
      const tokens: GoogleTokenResponse = tokenResponse.data;
      if (!tokens.access_token) {
        return null;
      }
      const channelsResponse = await axios.get<YoutubeChannelsListResponse>(
        YOUTUBE_CHANNELS_URL,
        {
          params: {part: 'snippet', mine: true},
          headers: {Authorization: `Bearer ${tokens.access_token}`},
        },
      );
      const channel = parseYoutubeMineChannelList(channelsResponse.data);
      return {
        provider: 'youtube',
        id: channel.id,
        username: channel.handle || channel.title || channel.id,
        nickname: channel.title || undefined,
        handle: channel.handle,
      };
    } catch (error) {
      if (error instanceof OAuthYoutubeChannelRequiredError) {
        throw error;
      }
      if (isYoutubeDataApiDisabled(error)) {
        throw new OAuthYoutubeApiDisabledError();
      }
      return null;
    }
  },
};
