import { convertToPUA } from '@/misc/utils/data/searchHelpers.js';
import type { PassDifficultySubtype } from '@/server/services/submissions/passDifficultySubtype.js';

export type SubmissionQueueKind = 'pass' | 'level';

export type SubmissionQueueIndexDocument = {
  kind: SubmissionQueueKind;
  id: number;
  isLocked: 0 | 1;
  createdAt: string;
  difficultySort: number | null;
  difficultySubtype: PassDifficultySubtype | null;
  ratio: number | null;
  acceptedCount: number;
  decidedCount: number;
  searchText: string;
  userId: string | null;
  levelId: number | null;
  creatorIds: number[];
  playerIds: number[];
  songIds: number[];
  artistIds: number[];
  teamIds: number[];
};

export type SubmissionQueueIndexInput = {
  kind: SubmissionQueueKind;
  id: number;
  isLocked: boolean;
  createdAt: Date | string;
  userId: string | null;
  levelId: number | null;
  difficultySort: number | null;
  difficultySubtype: PassDifficultySubtype | null;
  ratio: number | null;
  acceptedCount: number;
  decidedCount: number;
  creatorIds: Array<number | null | undefined>;
  playerIds: Array<number | null | undefined>;
  songIds: Array<number | null | undefined>;
  artistIds: Array<number | null | undefined>;
  teamIds: Array<number | null | undefined>;
  searchParts: unknown[];
};

function uniquePositiveIds(ids: Array<number | null | undefined>): number[] {
  return [...new Set(ids.filter((id): id is number => id != null && Number.isInteger(id) && id > 0))];
}

function isoDate(value: Date | string): string {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : new Date(0).toISOString();
}

export function submissionQueueDocId(kind: SubmissionQueueKind, id: number): string {
  return `${kind}:${id}`;
}

export function parseSubmissionQueueDocId(
  raw: string | null | undefined,
): { kind: SubmissionQueueKind; id: number } | null {
  const match = /^(pass|level):(\d+)$/.exec(String(raw || ''));
  if (!match) return null;
  const id = Number(match[2]);
  if (!Number.isInteger(id) || id <= 0) return null;
  return { kind: match[1] as SubmissionQueueKind, id };
}

export function buildSubmissionQueueSearchText(parts: unknown[]): string {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const part of parts) {
    if (part == null || part === '') continue;
    const token = String(part).trim();
    if (!token) continue;
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tokens.push(convertToPUA(token));
  }
  return tokens.join(' ');
}

export function buildSubmissionQueueIndexDocument(
  input: SubmissionQueueIndexInput,
): SubmissionQueueIndexDocument {
  return {
    kind: input.kind,
    id: input.id,
    isLocked: input.isLocked ? 1 : 0,
    createdAt: isoDate(input.createdAt),
    difficultySort: input.difficultySort,
    difficultySubtype: input.difficultySubtype,
    ratio: input.ratio,
    acceptedCount: input.acceptedCount,
    decidedCount: input.decidedCount,
    searchText: buildSubmissionQueueSearchText(input.searchParts),
    userId: input.userId || null,
    levelId: input.levelId != null && Number.isInteger(input.levelId) && input.levelId > 0
      ? input.levelId
      : null,
    creatorIds: uniquePositiveIds(input.creatorIds),
    playerIds: uniquePositiveIds(input.playerIds),
    songIds: uniquePositiveIds(input.songIds),
    artistIds: uniquePositiveIds(input.artistIds),
    teamIds: uniquePositiveIds(input.teamIds),
  };
}
