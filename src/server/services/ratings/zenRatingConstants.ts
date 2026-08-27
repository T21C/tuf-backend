export const ZEN_DECK_UNIT = 5;
export const ZEN_DEFAULT_DECK_SIZE = 15;
export const ZEN_MAX_DECK_SIZE = 200;
export const ZEN_ALLOWED_DECK_SIZES = [
  5, 10, 15, 20, 25, 30, 40, 50, 60, 70, 80, 90, 100, 125, 150, 175, 200,
] as const;

/** Soft left-bias default; 0 = strict sort order, 100 = uniform across pool. */
export const ZEN_DEFAULT_RANDOMNESS = 40;
export const ZEN_MIN_RANDOMNESS = 0;
export const ZEN_MAX_RANDOMNESS = 100;
/** Max sorted candidates fetched before weighted sampling. */
export const ZEN_CANDIDATE_POOL_CAP = 500;

export type ZenDeckSize = (typeof ZEN_ALLOWED_DECK_SIZES)[number];
export type ZenRequestBand = 'P' | 'G' | 'U';

function parseOptionalBool(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === true || value === 'true' || value === '1') return true;
  if (value === false || value === 'false' || value === '0') return false;
  return undefined;
}

/**
 * Include P/G/U request bands. Defaults all on.
 * Legacy onlyLowDiff / excludeUniversals map onto the same include set.
 */
export function parseZenIncludeBands(body: Record<string, unknown>): {
  includeP: boolean;
  includeG: boolean;
  includeU: boolean;
} {
  const includeP = parseOptionalBool(body.includeP);
  const includeG = parseOptionalBool(body.includeG);
  const includeU = parseOptionalBool(body.includeU);
  if (
    includeP !== undefined ||
    includeG !== undefined ||
    includeU !== undefined
  ) {
    return {
      includeP: includeP !== false,
      includeG: includeG !== false,
      includeU: includeU !== false,
    };
  }

  const onlyLowDiff = parseOptionalBool(body.onlyLowDiff) === true;
  const excludeUniversals = parseOptionalBool(body.excludeUniversals) === true;
  if (onlyLowDiff) {
    return { includeP: true, includeG: false, includeU: false };
  }
  if (excludeUniversals) {
    return { includeP: true, includeG: true, includeU: false };
  }
  return { includeP: true, includeG: true, includeU: true };
}

export function isZenDeckSize(value: unknown): value is ZenDeckSize {
  const n = Number(value);
  return (ZEN_ALLOWED_DECK_SIZES as readonly number[]).includes(n);
}

export function clampZenRandomness(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return ZEN_DEFAULT_RANDOMNESS;
  return Math.min(
    ZEN_MAX_RANDOMNESS,
    Math.max(ZEN_MIN_RANDOMNESS, Math.round(n))
  );
}

export function peeksAllowedForDeckSize(deckSize: number): number {
  return Math.floor(deckSize / ZEN_DECK_UNIT);
}

/**
 * Weighted sample of K indices from a sorted pool of length N.
 * Position 0 is leftmost (highest priority). randomness 0 → first K;
 * 100 → uniform; mid → soft left bias via w_i = (N-i)^α, α=(1-t)/t.
 * Returns selected indices in ascending (original sort) order.
 */
export function sampleZenPoolIndices(
  poolSize: number,
  pickCount: number,
  randomness: number
): number[] {
  const n = Math.max(0, Math.floor(poolSize));
  const k = Math.min(Math.max(0, Math.floor(pickCount)), n);
  if (k === 0) return [];
  if (k === n) return Array.from({ length: n }, (_, i) => i);

  const r = clampZenRandomness(randomness);
  if (r === 0) {
    return Array.from({ length: k }, (_, i) => i);
  }

  if (r === 100) {
    // Fisher–Yates partial shuffle for uniform sample, then restore sort order.
    const indices = Array.from({ length: n }, (_, i) => i);
    for (let i = 0; i < k; i++) {
      const j = i + Math.floor(Math.random() * (n - i));
      const tmp = indices[i];
      indices[i] = indices[j];
      indices[j] = tmp;
    }
    return indices.slice(0, k).sort((a, b) => a - b);
  }

  const t = r / 100;
  const alpha = (1 - t) / t;

  // Efraimidis–Spirakis: key = U^(1/w); higher key → more likely selected.
  const keyed: { index: number; key: number }[] = [];
  for (let i = 0; i < n; i++) {
    const weight = Math.pow(n - i, alpha);
    const u = Math.random();
    // Avoid 0^positive → 0; clamp u away from 0.
    const safeU = u <= Number.MIN_VALUE ? Number.MIN_VALUE : u;
    keyed.push({ index: i, key: Math.pow(safeU, 1 / weight) });
  }
  keyed.sort((a, b) => b.key - a.key);
  return keyed
    .slice(0, k)
    .map((entry) => entry.index)
    .sort((a, b) => a - b);
}
