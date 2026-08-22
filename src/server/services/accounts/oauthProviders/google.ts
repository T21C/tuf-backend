import axios from 'axios';
import { sanitizeUsername } from '@/misc/utils/auth/username.js';
import {
  OAuthEmailRequiredError,
  type NormalizedOAuthProfile,
  type OAuthProviderAdapter,
} from './types.js';

const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
export const GOOGLE_OAUTH_SCOPES = ['openid', 'email', 'profile'] as const;

interface GoogleTokenResponse {
  access_token?: string;
}

interface GoogleUserInfo {
  sub?: string;
  email?: string;
  email_verified?: boolean | string;
}

function isEmailVerified(value: unknown): boolean {
  return value === true || value === 'true';
}

export function usernameFromGoogleEmail(email: string): string {
  const local = email.split('@')[0] ?? '';
  return sanitizeUsername(local);
}

export function buildGoogleAuthorizeUrl(
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_OAUTH_SCOPES.join(' '),
    state,
    prompt: 'select_account',
  });
  return `${GOOGLE_AUTHORIZE_URL}?${params.toString()}`;
}

export const googleOAuthProvider: OAuthProviderAdapter = {
  id: 'google',

  buildAuthorizeUrl({ redirectUri, state }) {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) {
      throw new Error('GOOGLE_CLIENT_ID is not set');
    }
    return buildGoogleAuthorizeUrl(clientId, redirectUri, state);
  },

  async exchangeCode({ code, redirectUri }): Promise<NormalizedOAuthProfile | null> {
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
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        },
      );
      const tokens: GoogleTokenResponse = tokenResponse.data;
      if (!tokens.access_token) {
        return null;
      }
      const userResponse = await axios.get(GOOGLE_USERINFO_URL, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      const profile: GoogleUserInfo = userResponse.data;
      if (!profile?.sub) {
        return null;
      }
      const email = typeof profile.email === 'string' ? profile.email.trim() : '';
      if (!email || !isEmailVerified(profile.email_verified)) {
        throw new OAuthEmailRequiredError();
      }
      return {
        provider: 'google',
        id: profile.sub,
        username: usernameFromGoogleEmail(email),
        email,
      };
    } catch (error) {
      if (error instanceof OAuthEmailRequiredError) {
        throw error;
      }
      return null;
    }
  },
};
