/** One UTC calendar day in ms (aligns with R2 lifecycle `Expiration.Days` style counting). */
export const PACK_DOWNLOAD_MS_PER_UTC_DAY = 24 * 60 * 60 * 1000;

/** Same length in seconds (for Redis TTL). */
export const PACK_DOWNLOAD_SECONDS_PER_UTC_DAY = 24 * 60 * 60;

const ENV_NAME = 'PACK_DOWNLOAD_URL_EXPIRES_DAYS';

/**
 * Integer days ≥ 1 from `PACK_DOWNLOAD_URL_EXPIRES_DAYS` (default 1).
 * Used for UI `expiresAt` and pack-download job Redis TTL on the main server.
 */
export function packDownloadUrlExpiresDays(): number {
    const raw = process.env[ENV_NAME];
    if (!raw) return 1;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.max(1, Math.floor(n)) : 1;
}

export function packDownloadDisplayExpiresAtIso(nowMs: number = Date.now()): string {
    const days = packDownloadUrlExpiresDays();
    return new Date(nowMs + days * PACK_DOWNLOAD_MS_PER_UTC_DAY).toISOString();
}

/** Redis TTL for `kind: pack_download` job records (covers displayed expiry + small grace). */
export function packDownloadJobProgressTtlSeconds(): number {
    return packDownloadUrlExpiresDays() * PACK_DOWNLOAD_SECONDS_PER_UTC_DAY + 3600;
}
