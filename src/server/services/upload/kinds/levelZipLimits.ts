const GIB = 1024 * 1024 * 1024;

/**
 * Hard cap for level-zip uploads (assembled archive on disk + CDN forward).
 * Real packs can exceed 10 GiB when creators ship large uncompressed WAV/video assets.
 */
export const LEVEL_ZIP_MAX_FILE_SIZE_BYTES = 12 * GIB;

/** Max simultaneous in-progress level-zip sessions per user (uploading/assembling). */
export const LEVEL_ZIP_MAX_CONCURRENT_SESSIONS = 3;
