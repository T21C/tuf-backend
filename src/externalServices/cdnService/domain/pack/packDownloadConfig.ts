function envNumber(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw === '') {
        return fallback;
    }
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Hard cap on a single pack's estimated output size. */
export const PACK_DOWNLOAD_MAX_SIZE_BYTES = 15 * 1024 * 1024 * 1024;

/**
 * Peak disk multiplier: extract tree + final zip (+ margin) vs estimated zip size.
 * Used for queue budgeting and preflight checks.
 */
export const PACK_DOWNLOAD_DISK_MULTIPLIER = envNumber('PACK_DOWNLOAD_DISK_MULTIPLIER', 2.2);

/** Sum of in-flight disk budgets allowed across concurrent pack jobs. */
export const PACK_DOWNLOAD_MAX_CONCURRENT_DISK_BYTES = envNumber(
    'PACK_DOWNLOAD_MAX_CONCURRENT_DISK_BYTES',
    Math.ceil(20 * 1024 * 1024 * 1024 * PACK_DOWNLOAD_DISK_MULTIPLIER),
);

/** Max pack generation jobs running at once (independent of size budget). */
export const PACK_DOWNLOAD_MAX_CONCURRENT_JOBS = Math.max(
    1,
    Math.floor(envNumber('PACK_DOWNLOAD_MAX_CONCURRENT_JOBS', 2)),
);

/** Minimum free bytes required on the pack volume before starting a job. */
export const PACK_DOWNLOAD_MIN_FREE_DISK_BYTES = envNumber(
    'PACK_DOWNLOAD_MIN_FREE_DISK_BYTES',
    5 * 1024 * 1024 * 1024,
);

/** Max parallel level DB fetches / extractions within one pack job. */
export const PACK_DOWNLOAD_PARALLELISM = Math.max(
    1,
    Math.floor(envNumber('PACK_DOWNLOAD_PARALLELISM', 6)),
);

/** Remove orphaned `pack-downloads/temp/*` dirs older than this age. */
export const PACK_DOWNLOAD_TEMP_SWEEP_MAX_AGE_MS = envNumber(
    'PACK_DOWNLOAD_TEMP_SWEEP_MAX_AGE_MS',
    2 * 60 * 60 * 1000,
);

export function computePackDiskBudgetBytes(estimatedSize: number): number {
    return Math.ceil(Math.max(0, estimatedSize) * PACK_DOWNLOAD_DISK_MULTIPLIER);
}
