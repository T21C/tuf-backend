import { parseQRange } from '@/misc/utils/data/communityTagEligibility.js';
import { ratingForAverage } from '@/misc/utils/data/autoraterResult.js';
import { parseRatingRange } from '@/misc/utils/data/RatingUtils.js';

export type RatingFlowId = 1 | 2 | 3;
export type CardBand = 'P' | 'G' | 'U' | 'Impossible' | null;
export type RankState = 'waiting' | 'rankable' | 'ratingOff';
export type SettleActor = 'rater' | 'admin' | null;
export type RequestBand = 'P' | 'G' | 'U';

export interface FlowDifficulty {
  id: number;
  name: string;
  type: string;
  sortOrder: number;
}

export interface FlowDetail {
  id: number;
  userId: string;
  rating: string;
  isCommunityRating: boolean;
}

export interface FlowTag {
  name: string;
}

export interface AutoraterCombined {
  tier: string;
  value: number | null;
  used: string[];
  rule: string;
  modelFingerprint: string | null;
}

export interface RatingFlowDecision {
  flow: RatingFlowId;
  cardBand: CardBand;
  rankState: RankState;
  settleActor: SettleActor;
  suggestedDiffName: string | null;
  showRankable: boolean;
  showRatingOff: boolean;
  autoRankDisabled: boolean;
  indicators: {
    judgementLimit: boolean;
    keyLimit: boolean;
  };
}

interface LadderPoint {
  index: number;
  name: string;
}

interface Ladder {
  byName: Map<string, LadderPoint>;
  names: string[];
}

const KEY_LIMIT_NAME = /key(?:\s+base)?\s+limit/i;

/** AVG tier from an AutoRater V2 display string, or a plain ladder name. */
export function combinedTierFromAutorater(rating: string | null | undefined): string | null {
  const text = String(rating ?? '').trim();
  if (!text) return null;
  const tier = ratingForAverage(text, 'autorater', 'autorater').replace(/ (low|mid|high)$/i, '').trim();
  if (!tier) return null;
  if (cardBandFromTier(tier) == null && !/^censored$/i.test(tier)) return null;
  return tier;
}

export function combinedTierFromDetails(
  details: FlowDetail[],
  autoraterUserId: string | null,
): string | null {
  if (!autoraterUserId) return null;
  const vote = details.find((detail) => !detail.isCommunityRating && detail.userId === autoraterUserId);
  return vote ? combinedTierFromAutorater(vote.rating) : null;
}

/** Prefer the saved AutoRater vote. Fall back to a previously stored combined blob. */
export function resolveCombinedTier(
  details: FlowDetail[],
  autoraterUserId: string | null,
  storedCombined: unknown,
): string | null {
  return combinedTierFromDetails(details, autoraterUserId)
    ?? combinedTierFromAutorater(readStoredCombined(storedCombined)?.tier);
}

export function parseAutoraterCombined(payload: unknown): AutoraterCombined | null {
  const root = asRecord(payload);
  if (!root) return null;
  if (typeof root.rating_result === 'string') {
    const tier = combinedTierFromAutorater(root.rating_result);
    if (!tier) return null;
    const used = [root.rr, root.v2, root.v21, root.v22]
      .filter((item): item is string => typeof item === 'string' && item.length > 0);
    return {
      tier,
      value: null,
      used,
      rule: typeof root.avg === 'string' ? root.avg : '',
      modelFingerprint: null,
    };
  }
  const rating = asRecord(root.rating) ?? root;
  const result = asRecord(rating.result);
  const combined = asRecord(result?.combined) ?? asRecord(rating.combined);
  if (!combined) return null;
  const tier = typeof combined.tier === 'string' ? combined.tier.trim() : '';
  if (!tier) return null;
  const value = typeof combined.value === 'number' && Number.isFinite(combined.value)
    ? combined.value
    : null;
  const used = Array.isArray(combined.used)
    ? combined.used.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
  const rule = typeof combined.rule === 'string' ? combined.rule : '';
  const fingerprint = typeof rating.model_fingerprint === 'string'
    ? rating.model_fingerprint
    : typeof root.model_fingerprint === 'string'
      ? root.model_fingerprint
      : null;
  return { tier, value, used, rule, modelFingerprint: fingerprint };
}

export function readStoredCombined(raw: unknown): AutoraterCombined | null {
  if (typeof raw === 'string') {
    try {
      return parseAutoraterCombined({ rating: { result: { combined: JSON.parse(raw) } } })
        ?? parseStoredShape(JSON.parse(raw));
    } catch {
      return null;
    }
  }
  return parseStoredShape(raw) ?? parseAutoraterCombined(raw);
}

export function isFloorQName(name: string | null | undefined, letter: 'G' | 'U'): boolean {
  const parsed = parseQRange(name);
  return parsed?.letter === letter && parsed.tier === 0;
}

export function explicitRequestBand(raw: string | null | undefined): RequestBand | null {
  const primary = String(raw ?? '').trim();
  if (!primary) return null;
  const withoutVote = primary.replace(/^\s*vote\b/i, '').trim();
  const text = withoutVote || primary;
  if (/^\s*vote\s*$/i.test(text)) return null;
  const bands: RequestBand[] = [];
  for (const part of parseRatingRange(text, new Set())) {
    const band = tokenBand(part);
    if (band) bands.push(band);
  }
  if (bands.length === 0) return null;
  if (bands.includes('U')) return 'U';
  if (bands.includes('G')) return 'G';
  return 'P';
}

export function cardBandFromTier(tier: string | null | undefined): CardBand {
  const text = String(tier ?? '').trim();
  if (!text) return null;
  if (/^impossible$/i.test(text)) return 'Impossible';
  const q = parseQRange(text);
  if (q) return q.letter === 'G' ? 'G' : 'U';
  const point = text.match(/^([PGU])(?:[1-9]|1[0-9]|20)$/i);
  if (point?.[1]) return point[1].toUpperCase() as 'P' | 'G' | 'U';
  return null;
}

export function evaluateRatingFlow(input: {
  diffId: number;
  diffName: string | null;
  clears: number;
  rerateNum: string | null;
  isDiscordVote: boolean;
  combinedTier: string | null;
  details: FlowDetail[];
  autoraterUserId: string | null;
  tags: FlowTag[];
  manuallyBlocked: boolean;
  difficulties: FlowDifficulty[];
}): RatingFlowDecision {
  const combinedTier = combinedTierFromAutorater(input.combinedTier);
  const cardBand = cardBandFromTier(combinedTier);
  const flow = assignFlow(input, cardBand);
  const indicators = {
    judgementLimit: input.tags.some((tag) => tag.name === 'Judgement Limit'),
    keyLimit: input.tags.some((tag) => tag.name === 'Key Limiter' || KEY_LIMIT_NAME.test(tag.name)),
  };
  const humans = humanDetails(input.details, input.autoraterUserId);
  const special = humans.some((detail) => mentionsSpecial(detail.rating, 'Impossible') || mentionsSpecial(detail.rating, 'Censored'));
  const autoRankDisabled = input.manuallyBlocked || indicators.judgementLimit || indicators.keyLimit || special;

  if (flow === 3) {
    return finish({
      flow,
      cardBand,
      rankState: 'waiting',
      settleActor: null,
      suggestedDiffName: null,
      autoRankDisabled,
      indicators,
    });
  }

  const ladder = buildLadder(input.difficulties);
  const agreement = flow === 1
    ? agreeFlow1(combinedTier, cardBand, humans, ladder, input.difficulties)
    : agreeFlow2(combinedTier, humans, ladder);

  let settleActor: SettleActor = null;
  if (agreement.rankState === 'rankable') {
    settleActor = flow === 1 && agreement.raterMaySettle && !autoRankDisabled ? 'rater' : 'admin';
  }

  return finish({
    flow,
    cardBand,
    rankState: agreement.rankState,
    settleActor,
    suggestedDiffName: agreement.suggestedDiffName,
    autoRankDisabled,
    indicators,
  });
}

function finish(partial: Omit<RatingFlowDecision, 'showRankable' | 'showRatingOff'>): RatingFlowDecision {
  const showRankable = partial.rankState === 'rankable'
    && (partial.flow !== 1 || !partial.autoRankDisabled);
  return {
    ...partial,
    showRankable,
    showRatingOff: partial.rankState === 'ratingOff',
  };
}

function assignFlow(
  input: {
    diffId: number;
    diffName: string | null;
    clears: number;
    rerateNum: string | null;
    isDiscordVote: boolean;
  },
  cardBand: CardBand,
): RatingFlowId {
  if (input.isDiscordVote) return 3;
  if (isFloorQName(input.diffName, 'U')) return 3;
  const rerateBand = explicitRequestBand(input.rerateNum);
  if (rerateBand === 'U') return 3;
  const unranked = input.diffId === 0 || /^unranked$/i.test(String(input.diffName ?? '').trim());
  const cleared = input.clears >= 1;
  if (unranked && cleared && cardBand === 'U') return 3;
  if (isFloorQName(input.diffName, 'G')) return 2;
  if (rerateBand === 'P' || rerateBand === 'G') return 2;
  if (unranked && cleared && cardBand === 'G') return 2;
  if (unranked) return 1;
  if (cardBand === 'U' || /^U/i.test(String(input.diffName ?? '').trim())) return 3;
  return 2;
}

function agreeFlow1(
  combinedTier: string | null,
  cardBand: CardBand,
  humans: FlowDetail[],
  ladder: Ladder,
  difficulties: FlowDifficulty[],
): { rankState: RankState; suggestedDiffName: string | null; raterMaySettle: boolean } {
  if (!combinedTier || cardBand == null || cardBand === 'Impossible') {
    return { rankState: humans.length > 0 ? 'ratingOff' : 'waiting', suggestedDiffName: null, raterMaySettle: false };
  }
  if (cardBand === 'G' || cardBand === 'U') {
    return agreeQBucket(combinedTier, humans, ladder, difficulties);
  }
  return agreePoint(combinedTier, humans, ladder);
}

function agreeQBucket(
  combinedTier: string,
  humans: FlowDetail[],
  ladder: Ladder,
  difficulties: FlowDifficulty[],
): { rankState: RankState; suggestedDiffName: string | null; raterMaySettle: boolean } {
  const catBucket = qBucketKey(combinedTier, ladder);
  if (!catBucket) {
    return { rankState: 'waiting', suggestedDiffName: null, raterMaySettle: false };
  }
  const votes = humans
    .map((detail) => qBucketKey(detail.rating, ladder))
    .filter((bucket): bucket is string => bucket != null);
  if (votes.length === 0) {
    return { rankState: 'waiting', suggestedDiffName: null, raterMaySettle: false };
  }
  if (votes.some((bucket) => bucket !== catBucket)) {
    return { rankState: 'ratingOff', suggestedDiffName: null, raterMaySettle: false };
  }
  const [letter, tierText] = catBucket.split(':');
  const suggested = qDifficultyName(letter as 'G' | 'U', Number(tierText), difficulties);
  if (!suggested) {
    return { rankState: 'ratingOff', suggestedDiffName: null, raterMaySettle: false };
  }
  return { rankState: 'rankable', suggestedDiffName: suggested, raterMaySettle: true };
}

function agreePoint(
  combinedTier: string,
  humans: FlowDetail[],
  ladder: Ladder,
): { rankState: RankState; suggestedDiffName: string | null; raterMaySettle: boolean } {
  const cat = ladder.byName.get(normalizeToken(combinedTier));
  const points = humans
    .map((detail) => ladder.byName.get(normalizeToken(detail.rating)))
    .filter((point): point is LadderPoint => point != null);
  if (!cat) {
    return { rankState: 'waiting', suggestedDiffName: null, raterMaySettle: false };
  }
  if (points.length === 0) {
    return { rankState: 'waiting', suggestedDiffName: null, raterMaySettle: false };
  }
  const first = points[0];
  const distance = Math.abs(first.index - cat.index);
  if (distance === 0) {
    return { rankState: 'rankable', suggestedDiffName: cat.name, raterMaySettle: true };
  }
  if (distance >= 2) {
    return { rankState: 'ratingOff', suggestedDiffName: null, raterMaySettle: false };
  }
  if (points.length < 2) {
    return { rankState: 'waiting', suggestedDiffName: null, raterMaySettle: false };
  }
  const second = points[1];
  const low = Math.min(first.index, cat.index);
  const high = Math.max(first.index, cat.index);
  if (second.index < low || second.index > high) {
    return { rankState: 'ratingOff', suggestedDiffName: null, raterMaySettle: false };
  }
  return { rankState: 'rankable', suggestedDiffName: second.name, raterMaySettle: false };
}

function agreeFlow2(
  combinedTier: string | null,
  humans: FlowDetail[],
  ladder: Ladder,
): { rankState: RankState; suggestedDiffName: string | null; raterMaySettle: boolean } {
  const cat = combinedTier ? ladder.byName.get(normalizeToken(combinedTier)) : undefined;
  const points = humans
    .map((detail) => ladder.byName.get(normalizeToken(detail.rating)))
    .filter((point): point is LadderPoint => point != null)
    .slice(0, 3);
  if (!cat) {
    return { rankState: 'waiting', suggestedDiffName: null, raterMaySettle: false };
  }
  if (points.length < 2) {
    return { rankState: 'waiting', suggestedDiffName: null, raterMaySettle: false };
  }
  if (points.length === 2) {
    if (span(points) > 3) {
      return { rankState: 'waiting', suggestedDiffName: null, raterMaySettle: false };
    }
    if (!clusterNearCat(points, cat.index)) {
      return { rankState: 'ratingOff', suggestedDiffName: null, raterMaySettle: false };
    }
    return {
      rankState: 'rankable',
      suggestedDiffName: ladder.names[medianIndex(points.map((point) => point.index))] ?? null,
      raterMaySettle: false,
    };
  }
  if (span(points) <= 3 && clusterNearCat(points, cat.index)) {
    return {
      rankState: 'rankable',
      suggestedDiffName: ladder.names[medianIndex(points.map((point) => point.index))] ?? null,
      raterMaySettle: false,
    };
  }
  let best: LadderPoint[] | null = null;
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      const pair = [points[i], points[j]];
      if (span(pair) > 3 || !clusterNearCat(pair, cat.index)) continue;
      if (!best || span(pair) < span(best)) best = pair;
    }
  }
  if (!best) {
    return { rankState: 'ratingOff', suggestedDiffName: null, raterMaySettle: false };
  }
  return {
    rankState: 'rankable',
    suggestedDiffName: ladder.names[medianIndex(best.map((point) => point.index))] ?? null,
    raterMaySettle: false,
  };
}

function span(points: LadderPoint[]): number {
  const indexes = points.map((point) => point.index);
  return Math.max(...indexes) - Math.min(...indexes);
}

function clusterNearCat(points: LadderPoint[], catIndex: number): boolean {
  const mean = points.reduce((sum, point) => sum + point.index, 0) / points.length;
  return Math.abs(mean - catIndex) <= 3;
}

function medianIndex(indexes: number[]): number {
  const sorted = [...indexes].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return Math.ceil((sorted[mid - 1] + sorted[mid]) / 2);
}

function humanDetails(details: FlowDetail[], autoraterUserId: string | null): FlowDetail[] {
  return [...details]
    .filter((detail) => !detail.isCommunityRating && detail.userId !== autoraterUserId)
    .sort((a, b) => a.id - b.id);
}

function buildLadder(difficulties: FlowDifficulty[]): Ladder {
  const rows = difficulties
    .filter((row) => String(row.type).toUpperCase() === 'PGU')
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
  const byName = new Map<string, LadderPoint>();
  const names: string[] = [];
  rows.forEach((row, index) => {
    names.push(row.name);
    byName.set(row.name.toUpperCase(), { index, name: row.name });
  });
  return { byName, names };
}

function qBucketKey(raw: string, ladder: Ladder): string | null {
  const token = normalizeToken(raw);
  const parsed = parseQRange(token);
  if (parsed && (parsed.letter === 'G' || parsed.letter === 'U')) {
    return `${parsed.letter}:${parsed.tier}`;
  }
  const point = ladder.byName.get(token);
  if (!point) return null;
  const match = point.name.match(/^([GU])(\d+)$/i);
  if (!match?.[1] || !match[2]) return null;
  const number = Number(match[2]);
  if (number < 1 || number > 20) return null;
  return `${match[1].toUpperCase()}:${Math.floor((number - 1) / 4)}`;
}

function qDifficultyName(letter: 'G' | 'U', tier: number, difficulties: FlowDifficulty[]): string | null {
  const matches = difficulties.filter((row) => {
    const parsed = parseQRange(row.name);
    return parsed?.letter === letter && parsed.tier === tier;
  });
  matches.sort((a, b) => {
    const prefix = `${letter}Q${tier}`;
    const aPref = a.name.toUpperCase().startsWith(prefix) ? 0 : 1;
    const bPref = b.name.toUpperCase().startsWith(prefix) ? 0 : 1;
    if (aPref !== bPref) return aPref - bPref;
    return a.sortOrder - b.sortOrder;
  });
  return matches[0]?.name ?? null;
}

function mentionsSpecial(rating: string, name: string): boolean {
  return rating
    .split(/[-~]/)
    .some((part) => part.trim().toLowerCase() === name.toLowerCase());
}

function normalizeToken(raw: string): string {
  return raw.trim().replace(/\+$/, '').toUpperCase();
}

function tokenBand(token: string): RequestBand | null {
  const text = token.trim().replace(/\+$/, '');
  if (!text) return null;
  const q = parseQRange(text);
  if (q) return q.letter === 'G' ? 'G' : 'U';
  const point = text.match(/^([PGU])([1-9]|1[0-9]|20)$/i);
  if (point?.[1]) return point[1].toUpperCase() as RequestBand;
  if (/^(?:[1-9]|1[0-9]|20(?:\.\d)?|21(?:\.[0-4])?)$/.test(text)) {
    const value = Number(text);
    if (value >= 21) return 'U';
    if (value >= 20) return 'G';
    return 'P';
  }
  return null;
}

function parseStoredShape(raw: unknown): AutoraterCombined | null {
  const row = asRecord(raw);
  if (!row || typeof row.tier !== 'string' || !row.tier.trim()) return null;
  return {
    tier: row.tier.trim(),
    value: typeof row.value === 'number' && Number.isFinite(row.value) ? row.value : null,
    used: Array.isArray(row.used) ? row.used.filter((item): item is string => typeof item === 'string') : [],
    rule: typeof row.rule === 'string' ? row.rule : '',
    modelFingerprint: typeof row.modelFingerprint === 'string' ? row.modelFingerprint : null,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
