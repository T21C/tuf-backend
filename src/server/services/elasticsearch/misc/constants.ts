export const MAX_BATCH_SIZE = 4000;
export const BATCH_SIZE = 500;

/** Debounce window for batched artist-related level reindexes (ms). */
export const ARTIST_REINDEX_DEBOUNCE_MS = 30000;

/** Max time to hold pass CDC work before flushing without an idle signal (ms). */
export const CDC_PASS_MAX_COALESCE_MS = 30_000;

/** BLOCK timeout on `cdc:passes` consumer — shorter = faster idle detection after backlog. */
export const CDC_PASSES_STREAM_BLOCK_MS = 1000;
