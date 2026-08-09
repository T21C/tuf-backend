import { getRandomSeed } from '@/misc/utils/server/random.js';

/** True when sort is RANDOM_ASC / RANDOM_DESC (KEY_DIR convention). */
export function isRandomSortParam(sort?: string): boolean {
  if (!sort) return false;
  const sortKey = sort.split('_').slice(0, -1).join('_');
  return sortKey === 'RANDOM';
}

/**
 * Accept an integer query seed; generate one if missing/invalid.
 * ES random_score seeds are longs; we keep values in unsigned 32-bit range.
 */
export function resolveSearchSeed(raw?: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw) && Number.isInteger(raw)) {
    return raw >>> 0;
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && Number.isInteger(parsed)) {
      return parsed >>> 0;
    }
  }
  return getRandomSeed();
}

/** Wrap a query so scoring is a deterministic random order for `seed`. */
export function wrapQueryWithSeededRandom(query: any, seed: number) {
  return {
    function_score: {
      query: query ?? { match_all: {} },
      random_score: {
        seed,
        field: 'id',
      },
      boost_mode: 'replace',
    },
  };
}

export function getSeededRandomSortOptions(direction: 'asc' | 'desc' = 'desc') {
  return [{ _score: direction }, { id: 'desc' }];
}
