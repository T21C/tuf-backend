/** Discord-aligned username rules (Pomelo / migrated usernames). */
export const USERNAME_MIN_LEN = 2;
export const USERNAME_MAX_LEN = 32;

// Letters, numbers, underscore, period (Discord does not allow hyphens or spaces).
export const USERNAME_REGEX = /^[a-zA-Z0-9_.]+$/;

export function usernameHasConsecutivePeriods(username: string): boolean {
  return username.includes('..');
}

export function getUsernameFormatError(username: string): string | null {
  if (username.length < USERNAME_MIN_LEN || username.length > USERNAME_MAX_LEN) {
    return `Username must be between ${USERNAME_MIN_LEN} and ${USERNAME_MAX_LEN} characters`;
  }
  if (!USERNAME_REGEX.test(username)) {
    return 'Username can only contain letters, numbers, underscores (_) and periods (.)';
  }
  if (usernameHasConsecutivePeriods(username)) {
    return 'Username cannot contain two consecutive periods (..)';
  }
  return null;
}

export function isValidUsername(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  const username = raw.trim();
  return getUsernameFormatError(username) === null;
}

/** Lowercase for Discord-style case-insensitive matching. */
export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

/** True when incoming username (after normalization) differs from the stored value. */
export function isUsernameChanging(incomingRaw: unknown, currentStored: string): boolean {
  const incoming =
    typeof incomingRaw === 'string' && incomingRaw.length
      ? normalizeUsername(incomingRaw)
      : undefined;
  if (!incoming) return false;
  return incoming !== normalizeUsername(currentStored);
}

/** Normalized username from request body, or undefined when absent/empty. */
export function parseUsernameFromBody(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.length ? normalizeUsername(raw) : undefined;
}

export function sanitizeUsername(raw: unknown): string {
  const base = typeof raw === 'string' ? normalizeUsername(raw) : '';
  let cleaned = base.replace(/[^a-z0-9_.]+/g, '_');
  while (cleaned.includes('..')) {
    cleaned = cleaned.replace(/\.\./g, '.');
  }
  cleaned = cleaned.slice(0, USERNAME_MAX_LEN);
  if (cleaned.length < USERNAME_MIN_LEN) {
    return `user_${Math.floor(Math.random() * 10000)}`;
  }
  return cleaned;
}
