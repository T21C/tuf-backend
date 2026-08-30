import {
  isConfiguredSiteLanguage,
  normalizeSiteLanguage,
} from '@/config/siteLanguages.js';

export const CLIENT_PREFERENCE_KEYS = {
  HOME_RESOURCES_CTA_DISMISSED: 'home.resourcesCta.dismissed',
  MODS_START_GUIDE_CTA_DISMISSED: 'mods.startGuideCta.dismissed',
  TUFHELPERLITE_NEVER_SHOW: 'tufhelperlite.neverShow',
  INBOX_PUSH_NUDGE_DISMISSED: 'inbox.pushNudge.dismissed',
  SUBMISSIONS_CDN_TOS_AGREED: 'submissions.cdnTos.agreed',
  SUBMISSIONS_PASS_RULES_READ: 'submissions.passRules.read',
  APP_LANGUAGE: 'appLanguage',
  NAV_DROPDOWN_CLICK_MODE: 'navigation.dropdownClickMode',
  SUBMISSION_MINIMAL_MOTION: 'submission.minimalMotion',
  SUBMISSION_DISABLE_MASCOTS: 'submission.disableMascots',
  DISPLAY_HIDDEN_LEVEL_CARD_TAG_IDS: 'display.hiddenLevelCardTagIds',
} as const;

export type ClientPreferenceKey =
  (typeof CLIENT_PREFERENCE_KEYS)[keyof typeof CLIENT_PREFERENCE_KEYS];

export type ClientPreferencesPayload = {
  [CLIENT_PREFERENCE_KEYS.HOME_RESOURCES_CTA_DISMISSED]?: true;
  [CLIENT_PREFERENCE_KEYS.MODS_START_GUIDE_CTA_DISMISSED]?: true;
  [CLIENT_PREFERENCE_KEYS.TUFHELPERLITE_NEVER_SHOW]?: boolean;
  [CLIENT_PREFERENCE_KEYS.INBOX_PUSH_NUDGE_DISMISSED]?: true;
  [CLIENT_PREFERENCE_KEYS.SUBMISSIONS_CDN_TOS_AGREED]?: true;
  [CLIENT_PREFERENCE_KEYS.SUBMISSIONS_PASS_RULES_READ]?: true;
  [CLIENT_PREFERENCE_KEYS.APP_LANGUAGE]?: string;
  [CLIENT_PREFERENCE_KEYS.NAV_DROPDOWN_CLICK_MODE]?: 'cycle' | 'pin';
  [CLIENT_PREFERENCE_KEYS.SUBMISSION_MINIMAL_MOTION]?: boolean;
  [CLIENT_PREFERENCE_KEYS.SUBMISSION_DISABLE_MASCOTS]?: boolean;
  [CLIENT_PREFERENCE_KEYS.DISPLAY_HIDDEN_LEVEL_CARD_TAG_IDS]?: number[];
};

export const ALLOWED_CLIENT_PREFERENCE_KEYS = new Set<string>(
  Object.values(CLIENT_PREFERENCE_KEYS),
);

/** Dismiss-forever flags the client cannot turn back off. */
export const STICKY_TRUE_KEYS = new Set<string>([
  CLIENT_PREFERENCE_KEYS.HOME_RESOURCES_CTA_DISMISSED,
  CLIENT_PREFERENCE_KEYS.MODS_START_GUIDE_CTA_DISMISSED,
  CLIENT_PREFERENCE_KEYS.INBOX_PUSH_NUDGE_DISMISSED,
  CLIENT_PREFERENCE_KEYS.SUBMISSIONS_CDN_TOS_AGREED,
  CLIENT_PREFERENCE_KEYS.SUBMISSIONS_PASS_RULES_READ,
]);

export const NAV_DROPDOWN_CLICK_MODES = ['cycle', 'pin'] as const;

export class ClientPreferenceError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'ClientPreferenceError';
    this.status = status;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNavDropdownClickMode(value: unknown): value is 'cycle' | 'pin' {
  return value === 'cycle' || value === 'pin';
}

function sanitizeHiddenTagIds(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const ids: number[] = [];
  const seen = new Set<number>();
  for (const item of value) {
    const id = typeof item === 'number' ? item : Number(item);
    if (!Number.isFinite(id)) return null;
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * Validate a PATCH body. Unknown keys fail. Sticky-true keys with a non-true
 * value are ignored (no-op) rather than rejected. Returns the subset to merge.
 */
export function sanitizeClientPreferencePatch(
  body: unknown,
): ClientPreferencesPayload {
  if (!isPlainObject(body)) {
    throw new ClientPreferenceError('Body must be a JSON object');
  }

  const patch: ClientPreferencesPayload = {};

  for (const [key, raw] of Object.entries(body)) {
    if (!ALLOWED_CLIENT_PREFERENCE_KEYS.has(key)) {
      throw new ClientPreferenceError(`Unknown preference key: ${key}`);
    }

    if (STICKY_TRUE_KEYS.has(key)) {
      if (raw === true) {
        (patch as Record<string, unknown>)[key] = true;
      }
      continue;
    }

    if (key === CLIENT_PREFERENCE_KEYS.TUFHELPERLITE_NEVER_SHOW) {
      if (typeof raw !== 'boolean') {
        throw new ClientPreferenceError(`${key} must be a boolean`);
      }
      patch[CLIENT_PREFERENCE_KEYS.TUFHELPERLITE_NEVER_SHOW] = raw;
      continue;
    }

    if (key === CLIENT_PREFERENCE_KEYS.APP_LANGUAGE) {
      const code = normalizeSiteLanguage(raw);
      if (!isConfiguredSiteLanguage(code)) {
        throw new ClientPreferenceError('appLanguage is not a configured site language');
      }
      patch[CLIENT_PREFERENCE_KEYS.APP_LANGUAGE] = code;
      continue;
    }

    if (key === CLIENT_PREFERENCE_KEYS.NAV_DROPDOWN_CLICK_MODE) {
      if (!isNavDropdownClickMode(raw)) {
        throw new ClientPreferenceError('navigation.dropdownClickMode must be cycle or pin');
      }
      patch[CLIENT_PREFERENCE_KEYS.NAV_DROPDOWN_CLICK_MODE] = raw;
      continue;
    }

    if (
      key === CLIENT_PREFERENCE_KEYS.SUBMISSION_MINIMAL_MOTION
      || key === CLIENT_PREFERENCE_KEYS.SUBMISSION_DISABLE_MASCOTS
    ) {
      if (typeof raw !== 'boolean') {
        throw new ClientPreferenceError(`${key} must be a boolean`);
      }
      (patch as Record<string, unknown>)[key] = raw;
      continue;
    }

    if (key === CLIENT_PREFERENCE_KEYS.DISPLAY_HIDDEN_LEVEL_CARD_TAG_IDS) {
      const ids = sanitizeHiddenTagIds(raw);
      if (!ids) {
        throw new ClientPreferenceError('display.hiddenLevelCardTagIds must be an array of numbers');
      }
      patch[CLIENT_PREFERENCE_KEYS.DISPLAY_HIDDEN_LEVEL_CARD_TAG_IDS] = ids;
    }
  }

  return patch;
}

/** Drop unknown / invalid keys from a stored blob. Sticky keys only survive as true. */
export function normalizeStoredClientPreferences(
  raw: unknown,
): ClientPreferencesPayload {
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (!isPlainObject(raw)) return {};
  const cleaned: ClientPreferencesPayload = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!ALLOWED_CLIENT_PREFERENCE_KEYS.has(key)) continue;
    try {
      const piece = sanitizeClientPreferencePatch({[key]: value});
      Object.assign(cleaned, piece);
    } catch {
      /* skip invalid value for this key */
    }
  }
  return cleaned;
}

export function mergeClientPreferences(
  existing: ClientPreferencesPayload,
  patch: ClientPreferencesPayload,
): ClientPreferencesPayload {
  const next: ClientPreferencesPayload = {...existing};

  for (const [key, value] of Object.entries(patch) as [ClientPreferenceKey, unknown][]) {
    if (STICKY_TRUE_KEYS.has(key)) {
      if (value === true) {
        (next as Record<string, unknown>)[key] = true;
      }
      continue;
    }
    (next as Record<string, unknown>)[key] = value;
  }

  for (const key of STICKY_TRUE_KEYS) {
    if ((existing as Record<string, unknown>)[key] === true) {
      (next as Record<string, unknown>)[key] = true;
    }
  }

  return next;
}
