/**
 * Canonical song/artist verification enums. Models, request tables, and
 * sequelize-free parsers (e.g. form DTO) must import from here so lists cannot drift.
 * TUF Verified is a separate boolean column (`tufVerified`) on songs and artists,
 * not a verificationState value.
 */

export const SONG_VERIFICATION_STATES = [
  'declined',
  'pending',
  'conditional',
  'ysmod_only',
  'allowed',
] as const;

export type SongVerificationState = (typeof SONG_VERIFICATION_STATES)[number];

const SONG_VERIFICATION_STATE_SET: ReadonlySet<string> = new Set(SONG_VERIFICATION_STATES);

export function isSongVerificationState(value: unknown): value is SongVerificationState {
  return typeof value === 'string' && SONG_VERIFICATION_STATE_SET.has(value);
}

export function parseSongVerificationState(value: unknown): SongVerificationState | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return isSongVerificationState(trimmed) ? trimmed : null;
}

/** ENUM order must match the artists.verificationState MySQL column. */
export const ARTIST_VERIFICATION_STATES = [
  'unverified',
  'pending',
  'declined',
  'mostly_declined',
  'mostly_allowed',
  'allowed',
  'ysmod_only',
] as const;

export type ArtistVerificationState = (typeof ARTIST_VERIFICATION_STATES)[number];

const ARTIST_VERIFICATION_STATE_SET: ReadonlySet<string> = new Set(ARTIST_VERIFICATION_STATES);

export function isArtistVerificationState(value: unknown): value is ArtistVerificationState {
  return typeof value === 'string' && ARTIST_VERIFICATION_STATE_SET.has(value);
}

export function parseArtistVerificationState(value: unknown): ArtistVerificationState | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return isArtistVerificationState(trimmed) ? trimmed : null;
}

/** Query/body parser for the independent TUF Verified flag. */
export function parseTufVerifiedFlag(value: unknown): boolean | null {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === 'true' || trimmed === '1') return true;
  if (trimmed === 'false' || trimmed === '0') return false;
  return null;
}
