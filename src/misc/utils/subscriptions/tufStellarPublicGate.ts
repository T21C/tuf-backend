import { isTufStellarFeatureEnabled } from '@/config/app.config.js';

/**
 * Strip public TUFStellar fields from API-facing Elasticsearch documents when the feature is off.
 * Index payloads may still contain historical values until reindex.
 */
export function maskStellarPublicEsDoc<T extends Record<string, unknown>>(doc: T | null | undefined): T | null {
  if (doc == null || isTufStellarFeatureEnabled()) return doc ?? null;
  const out = { ...doc } as Record<string, unknown>;
  if ('tufStellarIconVariant' in out) {
    out.tufStellarIconVariant = '1';
  }
  const u = out.user;
  if (u && typeof u === 'object' && !Array.isArray(u)) {
    out.user = {
      ...(u as Record<string, unknown>),
      tufStellarSubscriptionExpiresAt: null,
    };
  }
  return out as T;
}

export function maskStellarPublicEsHits<T>(hits: T[]): T[] {
  if (isTufStellarFeatureEnabled()) return hits;
  return hits.map((h) => maskStellarPublicEsDoc(h as Record<string, unknown>) as T);
}
