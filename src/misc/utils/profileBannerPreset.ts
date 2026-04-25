import { getAllowedBannerPresetSet, DEFAULT_PROFILE_BANNER_PRESET } from '@/config/profileBannerPresets.js';

const allowedSet = getAllowedBannerPresetSet();

/**
 * Normalize client input: trim, strip leading slashes.
 */
export function normalizeBannerPresetInput(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (!t) return null;
  return t.replace(/^\/+/, '');
}

/**
 * Returns canonical preset string for DB, or null to clear.
 * Throws when invalid non-empty value.
 */
export function parseBannerPresetForStorage(raw: unknown): string | null {
  const normalized = normalizeBannerPresetInput(raw);
  if (normalized == null) return null;
  if (!allowedSet.has(normalized)) {
    throw new Error('Invalid banner preset');
  }
  return normalized;
}

export { DEFAULT_PROFILE_BANNER_PRESET };
