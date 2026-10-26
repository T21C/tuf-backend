import Player from '@/models/players/Player.js';
import {getClientPreferences} from '@/server/services/auth/ClientPreferenceService.js';
import type {TufStellarDisplayCurrencyPreference} from '@/server/services/billing/tufStellarDisplayCurrencyLocale.js';

export async function loadTufStellarDisplayCurrencyPreference(user: {
  id: string;
  playerId?: number | null;
}): Promise<TufStellarDisplayCurrencyPreference> {
  const [player, prefs] = await Promise.all([
    user.playerId != null
      ? Player.findByPk(user.playerId, {attributes: ['id', 'country']})
      : Promise.resolve(null),
    getClientPreferences(user.id),
  ]);
  const appLanguage = prefs.appLanguage;
  return {
    appLanguage: typeof appLanguage === 'string' && appLanguage.trim() ? appLanguage : null,
    playerCountry: player?.country ?? null,
  };
}
