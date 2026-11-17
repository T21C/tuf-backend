export const PENDING_SUBMISSION_SORTS = ['submitted', 'difficulty', 'ratio'] as const;
export type PendingSubmissionSort = (typeof PENDING_SUBMISSION_SORTS)[number];
export type PendingSubmissionSortDir = 'asc' | 'desc';

/** How each sort key is compared. Missing values sort after every real value. */
export const PENDING_SORT_VALUE_TYPES = {
  submitted: 'time',
  difficulty: 'difficulty',
  ratio: 'ratio',
} as const;

export type PendingSortValueType = (typeof PENDING_SORT_VALUE_TYPES)[PendingSubmissionSort];

/** Level queue: submit time, the submitted difficulty name, and the submitter's record. */
export const LEVEL_PENDING_SORTS = ['submitted', 'difficulty', 'ratio'] as const satisfies readonly PendingSubmissionSort[];

/** Pass queue: submit time, the chart difficulty, and the submitter's record. */
export const PASS_PENDING_SORTS = ['submitted', 'difficulty', 'ratio'] as const satisfies readonly PendingSubmissionSort[];

/** Accepts stored as millionths so 3/4 and a cursor round-trip as the same integer. */
export const RATIO_SCALE = 1_000_000;

export function isPendingSubmissionSort(value: string): value is PendingSubmissionSort {
  return (PENDING_SUBMISSION_SORTS as readonly string[]).includes(value);
}

export function pendingSortsFor(kind: 'level' | 'pass'): readonly PendingSubmissionSort[] {
  return kind === 'pass' ? PASS_PENDING_SORTS : LEVEL_PENDING_SORTS;
}

/** accepted / (accepted + declined), or null when the submitter has no decided submissions. */
export function ratioSortValue(accepted: number, declined: number): number | null {
  const total = accepted + declined;
  if (!Number.isFinite(total) || total <= 0) return null;
  return Math.round((accepted / total) * RATIO_SCALE);
}

function lookupDifficulty(byName: Map<string, number>, token: string): number | null {
  const key = token.trim().replace(/\+$/, '').toLowerCase();
  if (!key) return null;
  const order = byName.get(key);
  return order == null ? null : order;
}

/**
 * Map a free-text level difficulty ("U11", "G20-U1", "P1+") onto a difficulty sortOrder.
 * A range uses the higher endpoint. Unknown text has no sort value.
 */
export function difficultyTextSortValue(
  raw: string | null | undefined,
  byName: Map<string, number>,
): number | null {
  const input = String(raw ?? '').trim();
  if (!input) return null;
  const direct = lookupDifficulty(byName, input);
  if (direct != null) return direct;

  const range = input.match(/^([A-Za-z]*)(-?\d+)\s*[-~]\s*([A-Za-z]*)(-?\d+)\+?$/);
  if (!range) return null;
  const left = lookupDifficulty(byName, `${range[1]}${range[2]}`);
  const rightPrefix = range[3] || range[1];
  const right = lookupDifficulty(byName, `${rightPrefix}${range[4]}`);
  if (left == null && right == null) return null;
  if (left == null) return right;
  if (right == null) return left;
  return Math.max(left, right);
}
