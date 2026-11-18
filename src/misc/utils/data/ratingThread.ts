/** Pure rating-thread contract. No database, Discord, or environment access. */

import {normalizePguRequest} from '@/misc/utils/data/levelRequestValidation.js';

export type RatingThreadLifecycle = 'create' | 'close' | 'reopen';

/**
 * Split one mark on - and ~, copying a letter prefix onto a bare second number.
 * G1-2 becomes G1, -, G2 so each side can resolve to its own emoji.
 */
export function splitRatingRangeTokens(raw: string): string[] {
  const pieces = String(raw ?? '')
    .split(/([-~])/)
    .map((part) => part.trim())
    .filter((part) => part !== '');
  const out: string[] = [];
  let pendingPrefix = '';
  for (const piece of pieces) {
    if (piece === '-' || piece === '~') {
      out.push(piece);
      continue;
    }
    const match = piece.match(/^([A-Za-z]*)(-?\d+)$/);
    if (!match) {
      out.push(piece);
      pendingPrefix = '';
      continue;
    }
    const prefix = match[1];
    const num = match[2];
    if (!prefix && pendingPrefix) {
      out.push(`${pendingPrefix}${num}`);
    } else {
      out.push(piece);
      if (prefix) pendingPrefix = prefix;
    }
  }
  return out;
}

/**
 * Resolve a rating, including a shorthand range, to glued names and emojis.
 * G1-2 with :g1: and :g2: becomes :g1:-:g2:.
 */
export function formatDifficultyRangeMarks(
  raw: string,
  byName: ReadonlyMap<string, {name: string; emoji: string}>,
): {names: string; emojis: string} {
  const names: string[] = [];
  const emojis: string[] = [];
  for (const token of splitRatingRangeTokens(normalizePguRequest(raw))) {
    if (token === '-' || token === '~') {
      names.push(token);
      emojis.push(token);
      continue;
    }
    const row = byName.get(token.toLowerCase());
    const name = row?.name || token;
    const emoji = String(row?.emoji || '').trim();
    names.push(name);
    emojis.push(emoji || name);
  }
  return {names: names.join(''), emojis: emojis.join('')};
}

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
