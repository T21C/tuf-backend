export type OAuthMode = 'login' | 'linking' | 'reauth';

export const OAUTH_EMAIL_REQUIRED = 'OAUTH_EMAIL_REQUIRED';

export class OAuthEmailRequiredError extends Error {
  readonly code = OAUTH_EMAIL_REQUIRED;

  constructor(message = 'Google account must have a verified email') {
    super(message);
    this.name = 'OAuthEmailRequiredError';
  }
}

export function isOAuthEmailRequiredError(error: unknown): error is OAuthEmailRequiredError {
  return (
    error instanceof OAuthEmailRequiredError ||
    (typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as {code: unknown}).code === OAUTH_EMAIL_REQUIRED)
  );
}

export interface NormalizedOAuthProfile {
  provider: string;
  id: string;
  username: string;
  email?: string;
  nickname?: string;
  avatarId?: string;
  avatarUrl?: string;
}

export interface OAuthProviderAdapter {
  id: string;
  buildAuthorizeUrl(args: {
    redirectUri: string;
    state: string;
    mode: OAuthMode;
  }): string;
  exchangeCode(args: {
    code: string;
    redirectUri: string;
  }): Promise<NormalizedOAuthProfile | null>;
}
