/** MySQL signed INT range; also a hard ceiling for keyCount / passerId / levelId. */
export const MYSQL_INT_MAX = 2_147_483_647;
export const MYSQL_INT_MIN = -2_147_483_648;

/** Practical max for ADOFAI key lanes (well under INT; rejects garbage floats). */
export const MAX_PASS_KEY_COUNT = 64;

/**
 * Parse a strict integer in [min, max]. Returns null for empty/missing.
 * Rejects non-integers (including large floats that used to pass `> 0` checks).
 */
export function parseStrictInt(
  raw: unknown,
  opts: { min?: number; max?: number; allowEmpty?: boolean } = {},
): number | null {
  const min = opts.min ?? MYSQL_INT_MIN;
  const max = opts.max ?? MYSQL_INT_MAX;
  if (raw === null || raw === undefined || raw === '') {
    return null;
  }
  let n: number;
  if (typeof raw === 'number') {
    n = raw;
  } else if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return null;
    // Reject scientific notation / floats in string form via Number then integer check.
    n = Number(trimmed);
  } else if (typeof raw === 'bigint') {
    if (raw > BigInt(max) || raw < BigInt(min)) return null;
    return Number(raw);
  } else {
    return null;
  }
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    return null;
  }
  return n;
}

export function normalizeKeyCount(raw: unknown): number | null {
  return parseStrictInt(raw, { min: 1, max: MAX_PASS_KEY_COUNT });
}

export function deriveKeyFlags(keyCount: number | null): { is12K: boolean; is16K: boolean } {
  if (keyCount === null) {
    return { is12K: false, is16K: false };
  }
  if (keyCount >= 13) {
    return { is12K: false, is16K: true };
  }
  return { is12K: true, is16K: false };
}

/** Pass submissions require keyCount only on UQ0–UQ4 and U1–U20 levels. */
export function difficultyRequiresPassKeyCount(difficultyName: string | null | undefined): boolean {
  if (!difficultyName || typeof difficultyName !== 'string') {
    return false;
  }
  if (/^UQ[0-4]$/.test(difficultyName)) {
    return true;
  }
  const uMatch = difficultyName.match(/^U(\d+)$/);
  if (!uMatch) {
    return false;
  }
  const tier = parseInt(uMatch[1], 10);
  return tier >= 1 && tier <= 20;
}

export function assertPassKeyCountForDifficulty(
  difficultyName: string | null | undefined,
  keyCount: number | null,
): void {
  if (!difficultyRequiresPassKeyCount(difficultyName)) {
    return;
  }
  if (keyCount === null) {
    throw new Error(
      `Missing or invalid keyCount — must be an integer between 1 and ${MAX_PASS_KEY_COUNT}`,
    );
  }
}
