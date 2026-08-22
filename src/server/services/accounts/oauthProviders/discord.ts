import axios from 'axios';
import type {
  RESTGetAPIUserResult,
  RESTPostOAuth2AccessTokenResult,
} from 'discord-api-types/v10';
import type { NormalizedOAuthProfile, OAuthProviderAdapter } from './types.js';

const DISCORD_AUTHORIZE_URL = 'https://discord.com/api/oauth2/authorize';
const DISCORD_TOKEN_URL = 'https://discord.com/api/oauth2/token';
const DISCORD_USER_URL = 'https://discord.com/api/users/@me';
export const DISCORD_OAUTH_SCOPES = ['identify', 'email'] as const;

export function buildDiscordAuthorizeUrl(
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: DISCORD_OAUTH_SCOPES.join(' '),
    state,
  });
  return `${DISCORD_AUTHORIZE_URL}?${params.toString()}`;
}

export const discordOAuthProvider: OAuthProviderAdapter = {
  id: 'discord',

  buildAuthorizeUrl({ redirectUri, state }) {
    const clientId = process.env.DISCORD_CLIENT_ID;
    if (!clientId) {
      throw new Error('DISCORD_CLIENT_ID is not set');
    }
    return buildDiscordAuthorizeUrl(clientId, redirectUri, state);
  },

  async exchangeCode({ code, redirectUri }): Promise<NormalizedOAuthProfile | null> {
    const clientId = process.env.DISCORD_CLIENT_ID;
    const clientSecret = process.env.DISCORD_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      return null;
    }
    try {
      const tokenResponse = await axios.post(
        DISCORD_TOKEN_URL,
        new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri,
        }),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        },
      );
      const tokens: RESTPostOAuth2AccessTokenResult = tokenResponse.data;
      const userResponse = await axios.get(DISCORD_USER_URL, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      const profile: RESTGetAPIUserResult = userResponse.data;
      if (!profile?.id || !profile.username) {
        return null;
      }
      return {
        provider: 'discord',
        id: profile.id,
        username: profile.username,
        email: profile.email || undefined,
      };
    } catch {
      return null;
    }
  },
};
