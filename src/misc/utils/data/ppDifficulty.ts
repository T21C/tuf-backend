export type PpDifficultyCandidate = {
  id: number;
  baseScore: number;
  sortOrder: number;
  type?: string | null;
};

function parsedScore(value: unknown): number | null {
  const score = Number(value);
  if (!Number.isFinite(score) || score <= 0) return null;
  return score;
}

/**
 * Highest non-legacy difficulty whose default baseScore the PP score has reached.
 * Ties go to the higher sortOrder.
 */
export function derivePpDiffId(
  ppBaseScore: number | null | undefined,
  difficulties: PpDifficultyCandidate[] | null | undefined,
): number | null {
  const score = parsedScore(ppBaseScore);
  if (score == null || !Array.isArray(difficulties) || difficulties.length === 0) {
    return null;
  }

  let best: PpDifficultyCandidate | null = null;
  for (const diff of difficulties) {
    if (!diff || diff.type === 'LEGACY') continue;
    const base = Number(diff.baseScore);
    if (!Number.isFinite(base) || score < base) continue;
    if (
      !best ||
      base > Number(best.baseScore) ||
      (base === Number(best.baseScore) && diff.sortOrder > best.sortOrder)
    ) {
      best = diff;
    }
  }
  return best?.id ?? null;
}

/**
 * Keep an explicit difficulty id when it exists; otherwise derive from PP base score.
 * Unset/zero PP score always stores null.
 */
export function resolvePpDiffId(
  ppBaseScore: number | null | undefined,
  ppDiffId: number | null | undefined,
  difficulties: PpDifficultyCandidate[] | null | undefined,
): number | null {
  const score = parsedScore(ppBaseScore);
  if (score == null) return null;

  const explicit = Number(ppDiffId);
  if (Number.isFinite(explicit) && explicit > 0 && Array.isArray(difficulties)) {
    const found = difficulties.find((diff) => diff.id === explicit);
    if (found) return found.id;
  }
  return derivePpDiffId(score, difficulties);
}
