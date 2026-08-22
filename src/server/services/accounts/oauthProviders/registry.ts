import { discordOAuthProvider } from './discord.js';
import { googleOAuthProvider } from './google.js';
import type { OAuthProviderAdapter } from './types.js';

const adapters: Record<string, OAuthProviderAdapter> = {
  discord: discordOAuthProvider,
  google: googleOAuthProvider,
};

export function getOAuthProviderAdapter(id: unknown): OAuthProviderAdapter | null {
  if (typeof id !== 'string' || id.length === 0) return null;
  return adapters[id] ?? null;
}
