import UserClientPreferences from '@/models/auth/UserClientPreferences.js';
import {
  mergeClientPreferences,
  normalizeStoredClientPreferences,
  sanitizeClientPreferencePatch,
  type ClientPreferencesPayload,
} from './clientPreferencePayload.js';

export {
  ALLOWED_CLIENT_PREFERENCE_KEYS,
  CLIENT_PREFERENCE_KEYS,
  ClientPreferenceError,
  mergeClientPreferences,
  NAV_DROPDOWN_CLICK_MODES,
  normalizeStoredClientPreferences,
  sanitizeClientPreferencePatch,
  STICKY_TRUE_KEYS,
} from './clientPreferencePayload.js';
export type {
  ClientPreferenceKey,
  ClientPreferencesPayload,
} from './clientPreferencePayload.js';

export async function getClientPreferences(
  userId: string,
): Promise<ClientPreferencesPayload> {
  const row = await UserClientPreferences.findByPk(userId);
  return normalizeStoredClientPreferences(row?.payload);
}

export async function patchClientPreferences(
  userId: string,
  body: unknown,
): Promise<ClientPreferencesPayload> {
  const patch = sanitizeClientPreferencePatch(body);
  const [row] = await UserClientPreferences.findOrCreate({
    where: {userId},
    defaults: {userId, payload: {}},
  });
  const merged = mergeClientPreferences(
    normalizeStoredClientPreferences(row.payload),
    patch,
  );
  row.payload = merged as Record<string, unknown>;
  row.changed('payload', true);
  row.updatedAt = new Date();
  await row.save();
  return merged;
}
