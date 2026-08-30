/** Hard cap for hosted mod zip uploads. Independent of level-zip (12 GiB) limits. */
export const MOD_ZIP_MAX_BYTES = 100 * 1024 * 1024;
export const MOD_ZIP_MAX_ENTRY_COUNT = 256;
export const MOD_ZIP_MAX_ENTRY_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;
export const MOD_ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;
export const MOD_ZIP_MAX_COMPRESSION_RATIO = 100;
