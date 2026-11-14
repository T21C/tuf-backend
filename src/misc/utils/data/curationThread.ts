/** Pure curation-thread copy. No database, Discord, or environment access. */

import {normalizePguRequest} from '@/misc/utils/data/levelRequestValidation.js';
import {websiteRatingLabel} from '@/misc/utils/data/ratingThread.js';
import {curationTypeEmojiMarkup} from '@/misc/utils/data/curationTypeEmojis.js';

/**
 * Split a requested curation string the same way rating titles split P12-14:
 * keep -/~ in place, copy a letter prefix onto a bare second number (C0-1 → C0, C1).
 * Several types stay space-separated (C1 V2 Epic).
 */
export function curationThreadRequestedTokens(raw: string): string[] {
  const input = normalizePguRequest(websiteRatingLabel(raw));
  if (!input) return [];
  const out: string[] = [];
  for (const chunk of input.split(/\s+/).filter(Boolean)) {
    const pieces = chunk.split(/([-~])/).filter((part) => part !== '');
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
  }
  return out;
}

/** Join resolved names/emojis so ranges stay glued (C0-C1) and other types stay spaced. */
export function joinCurationThreadTokens(parts: readonly string[]): string {
  let out = '';
  for (const part of parts) {
    if (part === '-' || part === '~') {
      out += part;
      continue;
    }
    if (!out || /[-~]$/.test(out)) out += part;
    else out += ` ${part}`;
  }
  return out;
}

export function formatCurationThreadMarks(
  tokens: readonly string[],
  resolveName: (token: string) => string,
  resolveEmoji: (name: string) => string,
): {names: string; emojis: string} {
  const names: string[] = [];
  const emojis: string[] = [];
  for (const token of tokens) {
    if (token === '-' || token === '~') {
      names.push(token);
      emojis.push(token);
      continue;
    }
    const name = resolveName(token);
    names.push(name);
    emojis.push(resolveEmoji(name));
  }
  return {
    names: joinCurationThreadTokens(names),
    emojis: joinCurationThreadTokens(emojis),
  };
}

export function curationTypeMarkResolver(
  byName: Map<string, string>,
): {
  resolveName: (token: string) => string;
  resolveEmoji: (name: string) => string;
} {
  return {
    resolveName: (token) => byName.get(token.toLowerCase()) || token,
    resolveEmoji: (name) => curationTypeEmojiMarkup(name) || name,
  };
}

/** `{current} song (creator) ➔ {requested}` — same shape as a rating forum opener. */
export function formatCurationThreadHeadline(
  currentMark: string,
  songWithCreator: string,
  requestedMark: string,
): string {
  const left = [currentMark, songWithCreator].filter(Boolean).join(' ');
  const line = requestedMark ? `${left} ➔ ${requestedMark}` : left;
  return line.replace(/\s+/g, ' ').trim();
}
