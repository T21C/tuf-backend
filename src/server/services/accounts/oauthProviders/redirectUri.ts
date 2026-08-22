import { clientUrlEnv } from '@/config/app.config.js';

/** Single inbound OAuth redirect URI for every provider and mode. */
export function oauthCallbackRedirectUri(): string {
  const base = String(clientUrlEnv || 'http://localhost:5173').replace(/\/$/, '');
  return `${base}/callback`;
}
