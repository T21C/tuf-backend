import {
  clampZenRandomness,
  parseZenDeckSize,
  ZEN_MAX_DECK_SIZE,
} from '@/server/services/ratings/zenRatingConstants.js';

export const ZEN_SESSION_PHASES = ['setup', 'stage', 'done'] as const;
export type ZenSessionPhase = (typeof ZEN_SESSION_PHASES)[number];

export const ZEN_SESSION_SORT_PRESETS = ['least', 'most', 'id', 'recent'] as const;
export type ZenSessionSortPreset = (typeof ZEN_SESSION_SORT_PRESETS)[number];

export const ZEN_CARD_OUTCOMES = ['rated', 'peeked', 'skipped'] as const;
export type ZenCardOutcome = (typeof ZEN_CARD_OUTCOMES)[number] | null;

export const ZEN_SESSION_MAX_COMMENT_LENGTH = 10_000;
export const ZEN_SESSION_MAX_RATING_LENGTH = 254;

export type ZenCardAnswer = {
  rating: string;
  comment: string;
  peeked: boolean;
  viewDurationSeconds: number;
} | null;

export type ZenSessionPayload = {
  phase: ZenSessionPhase;
  deckSize: number;
  includeP: boolean;
  includeG: boolean;
  includeU: boolean;
  sortPreset: ZenSessionSortPreset;
  randomness: number;
  ratingIds: number[];
  index: number;
  cardOutcomes: ZenCardOutcome[];
  cardAnswers: ZenCardAnswer[];
  peeksLeft: number;
  peeksAllowed: number;
  peeksUsed: number;
  cardPeeked: boolean;
  submitted: number;
  skipped: number;
  streak: number;
  pendingRating: string;
  pendingComment: string;
};

export class ZenSessionError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'ZenSessionError';
    this.status = status;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asBool(value: unknown, fallback: boolean): boolean {
  if (value === true || value === 'true' || value === '1') return true;
  if (value === false || value === 'false' || value === '0') return false;
  return fallback;
}

function asNonNegInt(value: unknown, fallback = 0): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.floor(n));
}

function asBoundedString(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.slice(0, max);
}

function parseRatingId(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

function parseOutcome(value: unknown): ZenCardOutcome {
  if (value === 'rated' || value === 'peeked' || value === 'skipped') return value;
  return null;
}

function parseAnswer(value: unknown): ZenCardAnswer {
  if (!isPlainObject(value)) return null;
  return {
    rating: asBoundedString(value.rating, ZEN_SESSION_MAX_RATING_LENGTH),
    comment: asBoundedString(value.comment, ZEN_SESSION_MAX_COMMENT_LENGTH),
    peeked: asBool(value.peeked, false),
    viewDurationSeconds: asNonNegInt(value.viewDurationSeconds, 0),
  };
}

function isSortPreset(value: unknown): value is ZenSessionSortPreset {
  return (
    value === 'least' ||
    value === 'most' ||
    value === 'id' ||
    value === 'recent'
  );
}

function isPhase(value: unknown): value is ZenSessionPhase {
  return value === 'setup' || value === 'stage' || value === 'done';
}

export function isUnfinishedZenPayload(
  payload: ZenSessionPayload | null | undefined
): boolean {
  if (!payload) return false;
  if (!Array.isArray(payload.ratingIds) || payload.ratingIds.length === 0) {
    return false;
  }
  return payload.phase === 'stage' || payload.phase === 'setup';
}

export function nextRatedInZen(
  bodyRatedInZen: boolean,
  hasExistingDetail: boolean
): {ok: true; ratedInZen: boolean} | {ok: false; status: 409; error: string} {
  if (bodyRatedInZen && hasExistingDetail) {
    return {
      ok: false,
      status: 409,
      error: 'Level already rated in Zen Mode',
    };
  }
  if (bodyRatedInZen) {
    return {ok: true, ratedInZen: true};
  }
  return {ok: true, ratedInZen: false};
}

export function compactZenSessionProgress(
  payload: ZenSessionPayload,
  survivingIdSet: Set<number>
): {payload: ZenSessionPayload; changed: boolean} {
  const keepIdx: number[] = [];
  for (let i = 0; i < payload.ratingIds.length; i++) {
    const id = payload.ratingIds[i];
    if (id != null && survivingIdSet.has(id)) keepIdx.push(i);
  }

  if (keepIdx.length === payload.ratingIds.length) {
    const maxIndex = Math.max(0, payload.ratingIds.length - 1);
    const clampedIndex =
      payload.ratingIds.length === 0
        ? 0
        : Math.min(maxIndex, payload.index);
    if (clampedIndex === payload.index) {
      return {payload, changed: false};
    }
    return {
      payload: {...payload, index: clampedIndex},
      changed: true,
    };
  }

  const ratingIds = keepIdx.map((i) => payload.ratingIds[i]);
  const cardOutcomes = keepIdx.map((i) => payload.cardOutcomes[i] ?? null);
  const cardAnswers = keepIdx.map((i) => payload.cardAnswers[i] ?? null);

  if (ratingIds.length === 0) {
    return {
      payload: {
        ...payload,
        ratingIds: [],
        cardOutcomes: [],
        cardAnswers: [],
        index: 0,
        cardPeeked: false,
        pendingRating: '',
        pendingComment: '',
        phase: payload.phase === 'setup' ? 'setup' : 'done',
      },
      changed: true,
    };
  }

  const oldIndex = payload.index;
  let newIndex = keepIdx.indexOf(oldIndex);
  if (newIndex < 0) {
    const after = keepIdx.findIndex((i) => i > oldIndex);
    newIndex = after >= 0 ? after : keepIdx.length - 1;
  }

  const currentAnswer = cardAnswers[newIndex];
  const currentOutcome = cardOutcomes[newIndex];
  const oldCurrentSurvived = keepIdx.includes(oldIndex);

  return {
    payload: {
      ...payload,
      ratingIds,
      cardOutcomes,
      cardAnswers,
      index: newIndex,
      cardPeeked: Boolean(
        currentAnswer?.peeked || currentOutcome === 'peeked'
      ),
      pendingRating: oldCurrentSurvived
        ? payload.pendingRating
        : currentAnswer?.rating || '',
      pendingComment: oldCurrentSurvived
        ? payload.pendingComment
        : currentAnswer?.comment || '',
      phase:
        payload.phase === 'stage' && ratingIds.length === 0
          ? 'done'
          : payload.phase,
    },
    changed: true,
  };
}

export function sanitizeZenSessionPayload(body: unknown): ZenSessionPayload {
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      throw new ZenSessionError('Body must be a JSON object');
    }
  }
  if (!isPlainObject(body)) {
    throw new ZenSessionError('Body must be a JSON object');
  }

  if (!isPhase(body.phase)) {
    throw new ZenSessionError('Invalid phase');
  }

  let deckSize: number;
  try {
    deckSize = parseZenDeckSize(body.deckSize);
  } catch {
    throw new ZenSessionError('Invalid deckSize');
  }

  if (!isSortPreset(body.sortPreset)) {
    throw new ZenSessionError('Invalid sortPreset');
  }

  if (!Array.isArray(body.ratingIds)) {
    throw new ZenSessionError('ratingIds must be an array');
  }
  if (body.ratingIds.length > ZEN_MAX_DECK_SIZE) {
    throw new ZenSessionError('ratingIds exceeds max deck size');
  }

  const ratingIds: number[] = [];
  for (const raw of body.ratingIds) {
    const id = parseRatingId(raw);
    if (id == null) {
      throw new ZenSessionError('ratingIds must be positive integers');
    }
    ratingIds.push(id);
  }

  if (!Array.isArray(body.cardOutcomes) || !Array.isArray(body.cardAnswers)) {
    throw new ZenSessionError('cardOutcomes and cardAnswers must be arrays');
  }
  if (
    body.cardOutcomes.length !== ratingIds.length ||
    body.cardAnswers.length !== ratingIds.length
  ) {
    throw new ZenSessionError('Progress arrays must match ratingIds length');
  }

  if (body.phase === 'stage' && ratingIds.length === 0) {
    throw new ZenSessionError('An active Zen deck cannot be empty');
  }

  const cardOutcomes = body.cardOutcomes.map((value) => parseOutcome(value));
  const cardAnswers = body.cardAnswers.map((value) => parseAnswer(value));
  const maxIndex = Math.max(0, ratingIds.length - 1);
  const index =
    ratingIds.length === 0
      ? 0
      : Math.min(maxIndex, asNonNegInt(body.index, 0));

  return {
    phase: body.phase,
    deckSize,
    includeP: asBool(body.includeP, true),
    includeG: asBool(body.includeG, true),
    includeU: asBool(body.includeU, true),
    sortPreset: body.sortPreset,
    randomness: clampZenRandomness(body.randomness),
    ratingIds,
    index,
    cardOutcomes,
    cardAnswers,
    peeksLeft: asNonNegInt(body.peeksLeft, 0),
    peeksAllowed: asNonNegInt(body.peeksAllowed, 0),
    peeksUsed: asNonNegInt(body.peeksUsed, 0),
    cardPeeked: asBool(body.cardPeeked, false),
    submitted: asNonNegInt(body.submitted, 0),
    skipped: asNonNegInt(body.skipped, 0),
    streak: asNonNegInt(body.streak, 0),
    pendingRating: asBoundedString(body.pendingRating, ZEN_SESSION_MAX_RATING_LENGTH),
    pendingComment: asBoundedString(
      body.pendingComment,
      ZEN_SESSION_MAX_COMMENT_LENGTH
    ),
  };
}
