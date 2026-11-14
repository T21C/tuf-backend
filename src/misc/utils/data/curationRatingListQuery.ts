import {parseCurationFlow, type CurationFlowId} from './curationFlow.js';

export const CURATION_RATING_LIST_PAGE_SIZE = 30;

export type CurationRatingListSort = 'id' | 'ratings' | 'updatedAt';
export type CurationRatingListOrder = 'ASC' | 'DESC';
export type ShowHideOnly = 'show' | 'hide' | 'only';
export type CurationVoteFilter = 'include' | 'exclude' | 'only';

export interface CurationRatingListQuery {
  offset: number;
  limit: number;
  query: string;
  sort: CurationRatingListSort;
  order: CurationRatingListOrder;
  myRated: ShowHideOnly;
  flow: CurationFlowId | null;
  vote: CurationVoteFilter;
  userId: string | null;
}

function parseSort(value: unknown): CurationRatingListSort {
  const text = String(value || '').trim();
  if (text === 'id' || text === 'updatedAt' || text === 'ratings') return text;
  return 'ratings';
}

function parseOrder(value: unknown): CurationRatingListOrder {
  return String(value || '').toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
}

function parseMyRated(value: unknown): ShowHideOnly {
  const text = String(value || '').trim();
  if (text === 'hide' || text === 'only') return text;
  return 'show';
}

function parseVoteFilter(value: unknown): CurationVoteFilter {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'exclude' || text === 'only') return text;
  return 'include';
}

/** Comma-separated positive ids, same rule as the difficulty rating list. */
export function parseCurationQueueCommaIds(query: string): number[] | null {
  if (!query.includes(',')) return null;
  const parts = query.split(',').map((part) => part.trim());
  if (!parts.some((part) => part !== '')) return null;
  if (!parts.every((part) => part === '' || /^\d+$/.test(part))) return null;
  return parts.filter((part) => part !== '').map((part) => parseInt(part, 10));
}

export function parseCurationRatingListQuery(
  query: Record<string, unknown>,
  userId: string | null,
): CurationRatingListQuery {
  const offset = Math.max(0, Math.floor(Number(query.offset) || 0));
  const limitRaw = Math.floor(Number(query.limit) || CURATION_RATING_LIST_PAGE_SIZE);
  const limit = Math.min(100, Math.max(1, limitRaw));
  return {
    offset,
    limit,
    query: typeof query.query === 'string' ? query.query.trim() : '',
    sort: parseSort(query.sort),
    order: parseOrder(query.order),
    myRated: parseMyRated(query.myRated),
    flow: parseCurationFlow(query.flow),
    vote: parseVoteFilter(query.vote),
    userId,
  };
}
