/** Prevents overlapping zip finalisation for the same level (HTTP 202 async + sync uploads). */
export const activeLevelZipFinalizeByLevelId = new Map<number, string>();
