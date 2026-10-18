/** Pure rating-thread contract. No database, Discord, or environment access. */

export type RatingThreadLifecycle = 'create' | 'close' | 'reopen';

/** Prefix a rating-page proposal so the chart is a Discord vote card. Idempotent. */
export function voteThreadLabel(raw: string): string {
  const requested = String(raw ?? '').trim().replace(/^\s*vote\b\s*/i, '').trim();
  return (requested ? `vote ${requested}` : 'vote').slice(0, 60);
}

/** Remove the Discord vote prefix so the chart is rated on the website again. */
export function websiteRatingLabel(raw: string): string {
  return String(raw ?? '').trim().replace(/^\s*vote\b\s*/i, '').trim().slice(0, 60);
}

/** Role pings are off unless the caller explicitly opts in. */
export function ratingThreadWantsPing(body: {ping?: unknown} | null | undefined): boolean {
  return body?.ping === true;
}

export function readRatingThreadRequest(body: unknown): {action: RatingThreadLifecycle; ping: boolean} {
  const record = body && typeof body === 'object' ? body as {action?: unknown; ping?: unknown} : {};
  const action: RatingThreadLifecycle = record.action === 'close' || record.action === 'reopen'
    ? record.action
    : 'create';
  return {action, ping: record.ping === true};
}
