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
