/**
 * Limits for deciding when a level must use streaming metadata extraction
 * instead of loading the full chart with adofai-lib (LevelDict).
 */

/** Max .adofai file size before skipping LevelDict (Node string / heap pressure). */
export const MAX_LEVEL_FILE_SIZE_FOR_PARSE = 10 * 1024 * 1024;

/**
 * Max `angleData` tile count for a full LevelDict parse.
 * Compact JSON can stay under `MAX_LEVEL_FILE_SIZE_FOR_PARSE` yet contain
 * hundreds of thousands of tiles and exhaust memory or stall the worker.
 */
export const MAX_LEVEL_TILECOUNT_FOR_FULL_PARSE = 50_000;
