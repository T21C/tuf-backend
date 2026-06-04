export function normalizeKeyCount(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') {
    return null;
  }
  const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n <= 0) {
    return null;
  }
  return n;
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
    throw new Error('Missing or invalid keyCount — must be a positive integer');
  }
}
