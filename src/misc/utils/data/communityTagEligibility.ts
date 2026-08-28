import type { CommunityTagConfig } from '@/config/app.config.js';
import type { CommunityTagScoreKnobs } from './communityTagScoring.js';

export const PGU_BANDS = ['P', 'G', 'U'] as const;
export const COMMUNITY_TAG_BANDS = ['P', 'G', 'U', 'SPEC'] as const;
export type CommunityTagBand = (typeof COMMUNITY_TAG_BANDS)[number];
export type PguBand = CommunityTagBand;
export type CommunityTagScoringMode = 'wilson' | 'skillset';

export type CommunityTagVoteBlockReason =
  | 'login'
  | 'banned'
  | 'deleted'
  | 'uncleared'
  | 'topPlay'
  | 'mustClear'
  | 'band'
  | null;

export type DifficultyLike = {
  id?: number;
  name?: string | null;
  type?: string | null;
  sortOrder?: number | null;
};

export type CommunityTagSettingsSource = {
  wilsonZ?: number | null;
  scoreOn?: number | null;
  scoreOff?: number | null;
  scoringMode?: string | null;
  allowedBands?: unknown;
  requireTopPlay?: unknown;
};

export type CommunityTagResolvedSettings = CommunityTagScoreKnobs & {
  scoringMode: CommunityTagScoringMode;
  allowedBands: CommunityTagBand[] | null;
  requireTopPlay: boolean;
};

export function pguBandFromDifficultyName(name: string | null | undefined): Extract<CommunityTagBand, 'P' | 'G' | 'U'> | null {
  const n = String(name || '').trim().toUpperCase();
  if (!n) return null;
  if (/^UQ/.test(n) || /^Q\d/.test(n)) return 'U';
  if (/^U\d/.test(n)) return 'U';
  if (/^G\d/.test(n)) return 'G';
  if (/^P\d/.test(n)) return 'P';
  return null;
}

export function communityTagBandFromDifficulty(
  difficulty: DifficultyLike | null | undefined,
): CommunityTagBand | null {
  const type = String(difficulty?.type || '').toUpperCase();
  if (type === 'SPECIAL' || type === 'LEGACY') return 'SPEC';
  return pguBandFromDifficultyName(difficulty?.name);
}

function normalizeBandToken(raw: unknown): CommunityTagBand | null {
  const band = String(raw).trim().toUpperCase();
  if (band === 'SPECIAL' || band === 'LEGACY') return 'SPEC';
  if ((COMMUNITY_TAG_BANDS as readonly string[]).includes(band)) {
    return band as CommunityTagBand;
  }
  return null;
}

export function parseAllowedBands(value: unknown): CommunityTagBand[] | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '' || value === 'null') return null;
  let parsed: unknown = value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      parsed = trimmed.split(',').map((part) => part.trim());
    }
  }
  if (!Array.isArray(parsed)) {
    throw new Error('Invalid allowedBands');
  }
  const bands: CommunityTagBand[] = [];
  for (const raw of parsed) {
    const band = normalizeBandToken(raw);
    if (band && !bands.includes(band)) bands.push(band);
  }
  return bands.length > 0 ? bands : null;
}

export function parseScoringMode(value: unknown): CommunityTagScoringMode | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const s = String(value).trim().toLowerCase();
  if (s === 'wilson' || s === 'skillset') return s;
  throw new Error('Invalid scoringMode');
}

export function parseOptionalBoolean(value: unknown): boolean | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === 0) return value === 1;
  const s = String(value).trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
  if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false;
  throw new Error('Invalid boolean');
}

export function parseOptionalPositiveNumber(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error('Invalid number');
  }
  return n;
}

export function parseOptionalUnitInterval(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new Error('Invalid threshold');
  }
  return n;
}

export function parseOptionalDescription(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function firstFinite(values: Array<number | null | undefined>, fallback: number): number {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return fallback;
}

export function resolveCommunityTagSettings(
  tag: CommunityTagSettingsSource,
  group: CommunityTagSettingsSource | null | undefined,
  env: CommunityTagConfig,
): CommunityTagResolvedSettings {
  let scoringMode: CommunityTagScoringMode = 'wilson';
  try {
    const tagMode = parseScoringMode(tag.scoringMode);
    const groupMode = parseScoringMode(group?.scoringMode);
    scoringMode = tagMode ?? groupMode ?? 'wilson';
  } catch {
    scoringMode = 'wilson';
  }

  let allowedBands: CommunityTagBand[] | null = null;
  try {
    const tagBands = parseAllowedBands(tag.allowedBands);
    const groupBands = parseAllowedBands(group?.allowedBands);
    allowedBands = tagBands === undefined ? (groupBands ?? null) : tagBands;
  } catch {
    allowedBands = null;
  }

  let requireTopPlay = false;
  try {
    requireTopPlay = parseOptionalBoolean(tag.requireTopPlay) === true;
  } catch {
    requireTopPlay = false;
  }

  return {
    wilsonZ: firstFinite([tag.wilsonZ, group?.wilsonZ], env.wilsonZ),
    scoreOn: firstFinite([tag.scoreOn, group?.scoreOn], env.scoreOn),
    scoreOff: firstFinite([tag.scoreOff, group?.scoreOff], env.scoreOff),
    scoringMode,
    allowedBands,
    requireTopPlay,
  };
}

export function tagAllowedForDifficulty(
  allowedBands: CommunityTagBand[] | null | undefined,
  difficulty: DifficultyLike | null | undefined,
): boolean {
  if (!allowedBands || allowedBands.length === 0) return true;
  const band = communityTagBandFromDifficulty(difficulty);
  if (!band) return false;
  return allowedBands.includes(band);
}

export function maxVotableSortOrder(
  topDiff: DifficultyLike | null | undefined,
  pguDifficulties: DifficultyLike[],
): number | null {
  if (!topDiff || topDiff.type !== 'PGU' || topDiff.sortOrder == null) return null;
  const list = [...pguDifficulties]
    .filter((d) => d.type === 'PGU' && d.sortOrder != null)
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  const idx = list.findIndex((d) => d.id != null && d.id === topDiff.id);
  if (idx >= 0) {
    const next = list[idx + 1];
    return next?.sortOrder ?? topDiff.sortOrder;
  }
  const nextByOrder = list.find((d) => (d.sortOrder ?? 0) > (topDiff.sortOrder ?? 0));
  return nextByOrder?.sortOrder ?? topDiff.sortOrder;
}

export function canVoteByTopPlay(
  levelDiff: DifficultyLike | null | undefined,
  topDiff: DifficultyLike | null | undefined,
  pguDifficulties: DifficultyLike[],
): boolean {
  const type = String(levelDiff?.type || '').toUpperCase();
  if (type === 'SPECIAL' || type === 'LEGACY') {
    return Boolean(topDiff && topDiff.type === 'PGU' && topDiff.sortOrder != null);
  }
  const max = maxVotableSortOrder(topDiff, pguDifficulties);
  if (max == null || levelDiff?.sortOrder == null) return false;
  return levelDiff.sortOrder <= max;
}

/**
 * Top-play + 1, or a live clear of this chart.
 * A clear of this level satisfies the requirement even when cached /me
 * player_stats.topDiff is missing or stale.
 */
export function isTopPlayRequirementSatisfied(opts: {
  levelDiff: DifficultyLike | null | undefined;
  topDiff: DifficultyLike | null | undefined;
  pguDifficulties: DifficultyLike[];
  hasClearOfThisLevel: boolean;
}): boolean {
  if (opts.hasClearOfThisLevel) return true;
  return canVoteByTopPlay(opts.levelDiff, opts.topDiff, opts.pguDifficulties);
}

export function normalizeVoteAction(action: string | undefined): 'upvote' | 'downvote' | 'unvote' | null {
  if (!action) return null;
  if (action === 'vote' || action === 'upvote') return 'upvote';
  if (action === 'downvote') return 'downvote';
  if (action === 'unvote') return 'unvote';
  return null;
}

export type CommunityTagKnobFields = {
  description?: string | null;
  wilsonZ?: number | null;
  scoreOn?: number | null;
  scoreOff?: number | null;
  scoringMode?: CommunityTagScoringMode | null;
  allowedBands?: CommunityTagBand[] | null;
  requireTopPlay?: boolean | null;
};

function wrapParse<T>(fn: () => T, message: string): T {
  try {
    return fn();
  } catch {
    throw new Error(message);
  }
}

export function parseCommunityTagKnobFields(
  body: Record<string, unknown>,
  opts: { includeDescription?: boolean } = {},
): CommunityTagKnobFields {
  const out: CommunityTagKnobFields = {};
  if (opts.includeDescription && 'description' in body) {
    out.description = parseOptionalDescription(body.description) ?? null;
  }
  if ('wilsonZ' in body) {
    out.wilsonZ = wrapParse(() => parseOptionalPositiveNumber(body.wilsonZ), 'Invalid wilsonZ') ?? null;
  }
  if ('scoreOn' in body) {
    out.scoreOn = wrapParse(() => parseOptionalUnitInterval(body.scoreOn), 'Invalid scoreOn') ?? null;
  }
  if ('scoreOff' in body) {
    out.scoreOff = wrapParse(() => parseOptionalUnitInterval(body.scoreOff), 'Invalid scoreOff') ?? null;
  }
  if ('scoringMode' in body) {
    out.scoringMode = wrapParse(() => parseScoringMode(body.scoringMode), 'Invalid scoringMode') ?? null;
  }
  if ('allowedBands' in body) {
    out.allowedBands = wrapParse(() => parseAllowedBands(body.allowedBands), 'Invalid allowedBands') ?? null;
  }
  if ('requireTopPlay' in body) {
    out.requireTopPlay = wrapParse(() => parseOptionalBoolean(body.requireTopPlay), 'Invalid requireTopPlay') ?? null;
  }
  return out;
}
