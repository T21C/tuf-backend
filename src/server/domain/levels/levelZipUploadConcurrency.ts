/** Prevents overlapping zip finalisation for the same level (HTTP 202 async + sync uploads). */
export const activeLevelZipFinalizeByLevelId = new Map<number, string>();

/** Same guard for pending level-submission zip edits. */
export const activeLevelZipFinalizeBySubmissionId = new Map<number, string>();
