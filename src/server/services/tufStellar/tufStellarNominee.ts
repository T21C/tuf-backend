export const MONTHLY_NOMINEE_THRESHOLD = 100;

export function utcMonthKey(now: Date): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

export function utcMonthBounds(now: Date): {start: Date; next: Date} {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return {start, next};
}

export function shouldEnqueueMonthlyNominee(input: {
  isNewOfficialVote: boolean;
  isAutorater: boolean;
  priorOfficialCountThisMonth: number;
}): boolean {
  if (!input.isNewOfficialVote) return false;
  if (input.isAutorater) return false;
  return input.priorOfficialCountThisMonth === MONTHLY_NOMINEE_THRESHOLD - 1;
}
