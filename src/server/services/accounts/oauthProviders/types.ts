export type OAuthMode = 'login' | 'linking' | 'reauth';

export const OAUTH_EMAIL_REQUIRED = 'OAUTH_EMAIL_REQUIRED';
export const OAUTH_YOUTUBE_CHANNEL_REQUIRED = 'OAUTH_YOUTUBE_CHANNEL_REQUIRED';
export const OAUTH_YOUTUBE_API_DISABLED = 'OAUTH_YOUTUBE_API_DISABLED';

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

export class OAuthYoutubeChannelRequiredError extends Error {
  readonly code = OAUTH_YOUTUBE_CHANNEL_REQUIRED;

  constructor(message = 'This Google account has no YouTube channel') {
    super(message);
    this.name = 'OAuthYoutubeChannelRequiredError';
  }
}

export function isOAuthYoutubeChannelRequiredError(
  error: unknown,
): error is OAuthYoutubeChannelRequiredError {
  return (
    error instanceof OAuthYoutubeChannelRequiredError ||
    (typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as {code: unknown}).code === OAUTH_YOUTUBE_CHANNEL_REQUIRED)
  );
}

export class OAuthYoutubeApiDisabledError extends Error {
  readonly code = OAUTH_YOUTUBE_API_DISABLED;

  constructor(
    message = 'YouTube Data API v3 is not enabled on this Google Cloud project',
  ) {
    super(message);
    this.name = 'OAuthYoutubeApiDisabledError';
  }
}

export function isOAuthYoutubeApiDisabledError(
  error: unknown,
): error is OAuthYoutubeApiDisabledError {
  return (
    error instanceof OAuthYoutubeApiDisabledError ||
    (typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as {code: unknown}).code === OAUTH_YOUTUBE_API_DISABLED)
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
  handle?: string | null;
}

export interface OAuthProviderAdapter {
  id: string;
  /** When true, the adapter may only be used to link an identity, never login or reauth. */
  linkOnly?: boolean;
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

export function isOAuthLinkOnlyBlocked(
  adapter: Pick<OAuthProviderAdapter, 'linkOnly'> | null | undefined,
  mode: OAuthMode,
): boolean {
  return Boolean(adapter?.linkOnly) && mode !== 'linking';
}
