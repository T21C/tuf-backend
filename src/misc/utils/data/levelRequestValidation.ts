/** Pure checks for level requests. No database or environment access. */

export const LEVEL_REQUEST_TYPES = [
  'rerate',
  'info_change',
  'tag',
  'curation',
  'curation_rerate',
] as const;

export type LevelRequestType = (typeof LEVEL_REQUEST_TYPES)[number];

export const LEVEL_REQUEST_STATUSES = [
  'pending',
  'accepted',
  'added_to_rating_page',
  'discord_vote',
  'rejected',
  'withdrawn',
  'completed',
  'completed_changed',
  'completed_unchanged',
] as const;

export type LevelRequestStatus = (typeof LEVEL_REQUEST_STATUSES)[number];

export const LEVEL_REQUEST_ACTIONS = [
  'accept',
  'reject',
  'complete',
  'add_to_rating',
  'discord_vote',
  'retry_discord',
  'delete_discord',
  'reopen_discord',
] as const;

export type LevelRequestAction = (typeof LEVEL_REQUEST_ACTIONS)[number];

export const RERATE_ONLY_STATUSES: LevelRequestStatus[] = [
  'added_to_rating_page',
  'discord_vote',
];

export const RATING_LINK_STATUSES: LevelRequestStatus[] = [
  'accepted',
  'added_to_rating_page',
  'discord_vote',
];

export const TERMINAL_LEVEL_REQUEST_STATUSES: LevelRequestStatus[] = [
  'rejected',
  'withdrawn',
  'completed',
  'completed_changed',
  'completed_unchanged',
];

export const RERATE_COOLDOWN_STATUSES: LevelRequestStatus[] = [
  'rejected',
  'withdrawn',
  'completed',
  'completed_changed',
  'completed_unchanged',
];

export const COMPLETED_LEVEL_REQUEST_STATUSES: LevelRequestStatus[] = [
  'rejected',
  'withdrawn',
  'completed',
  'completed_changed',
  'completed_unchanged',
];

export const LEVEL_REQUEST_REASON_MAX = 1000;
export const RERATE_COOLDOWN_MS = 15 * 60 * 1000;
export const LEVEL_REFERENCE_ID_LIMIT = 40;

export const INFO_CHANGE_KINDS = [
  'song',
  'artist',
  'credits',
  'video',
  'download',
  'description',
  'multiple',
] as const;

export type InfoChangeKind = (typeof INFO_CHANGE_KINDS)[number];

export const TAG_REQUEST_ACTIONS = ['add', 'remove', 'multiple'] as const;
export type TagRequestAction = (typeof TAG_REQUEST_ACTIONS)[number];

const PGU_TOKEN = /^[PGU]([1-9]|1[0-9]|20)$/i;

export function isLevelRequestType(value: unknown): value is LevelRequestType {
  return LEVEL_REQUEST_TYPES.includes(value as LevelRequestType);
}

export function isCurationRequestType(type: string): type is 'curation' | 'curation_rerate' {
  return type === 'curation' || type === 'curation_rerate';
}

export function curationRequestTypeForLevel(hasCuration: boolean): 'curation' | 'curation_rerate' {
  return hasCuration ? 'curation_rerate' : 'curation';
}

export function openRequestTypesFor(type: LevelRequestType): LevelRequestType[] {
  if (isCurationRequestType(type)) return ['curation', 'curation_rerate'];
  return [type];
}

export function normalizePositiveIdList(ids: unknown): number[] {
  if (!Array.isArray(ids)) return [];
  return [...new Set(ids.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
}

export function samePositiveIdSet(left: number[], right: number[]): boolean {
  if (left.length !== right.length) return false;
  const known = new Set(right);
  return left.every((id) => known.has(id));
}

export type CurationRequestIssue = 'curation_empty' | 'unchanged_curation';

/** New curation needs at least one type. A rerate must actually change the current types. */
export function curationRequestIssue(
  type: string,
  targetIds: number[],
  currentIds?: number[] | null,
): CurationRequestIssue | null {
  if (type === 'curation') return targetIds.length === 0 ? 'curation_empty' : null;
  if (type === 'curation_rerate') {
    if (!Array.isArray(currentIds)) return null;
    return samePositiveIdSet(targetIds, currentIds) ? 'unchanged_curation' : null;
  }
  return null;
}

export function tagRequestIssue(targetIds: number[], currentIds: number[]): 'unchanged_tags' | null {
  return samePositiveIdSet(targetIds, currentIds) ? 'unchanged_tags' : null;
}

export function canonicalLevelRequestStatus(value: unknown): LevelRequestStatus | null {
  if (typeof value !== 'string') return null;
  if (LEVEL_REQUEST_STATUSES.includes(value as LevelRequestStatus)) return value as LevelRequestStatus;
  return null;
}

export function isLevelRequestStatus(value: unknown): value is LevelRequestStatus {
  return canonicalLevelRequestStatus(value) != null;
}

export function isLevelRequestAction(value: unknown): value is LevelRequestAction {
  return LEVEL_REQUEST_ACTIONS.includes(value as LevelRequestAction);
}

export function isTerminalLevelRequestStatus(status: string): boolean {
  const canonical = canonicalLevelRequestStatus(status);
  return canonical != null && TERMINAL_LEVEL_REQUEST_STATUSES.includes(canonical);
}

export function completedRequestsFilter(query: {
  completed?: unknown;
  includeCompleted?: unknown;
}): 'hide' | 'show' | 'only' {
  const completed = typeof query.completed === 'string' ? query.completed.trim().toLowerCase() : '';
  if (completed === 'show' || completed === 'only' || completed === 'hide') return completed;
  if (query.includeCompleted === '1' || query.includeCompleted === true || query.includeCompleted === 'true') {
    return 'show';
  }
  return 'hide';
}

export function isOpenLevelRequestStatus(status: string): boolean {
  return !isTerminalLevelRequestStatus(status);
}

export function statusAllowedForType(type: LevelRequestType, status: LevelRequestStatus): boolean {
  const canonical = canonicalLevelRequestStatus(status);
  if (!canonical) return false;
  if (type === 'rerate') return canonical !== 'completed';
  return !RERATE_ONLY_STATUSES.includes(canonical);
}

export function actionsForRequest(
  type: LevelRequestType,
  status: string,
  flags?: {
    discordMessageUrl?: string | null;
    discordPostError?: string | null;
    discordThreadClosed?: boolean | null;
  },
): LevelRequestAction[] {
  const canonical = canonicalLevelRequestStatus(status);
  if (!canonical) return [];
  const hasThread = Boolean(flags?.discordMessageUrl);
  const threadClosed = type === 'rerate' && Boolean(flags?.discordThreadClosed);
  const postFailed = Boolean(flags?.discordPostError);
  let actions: LevelRequestAction[] = [];
  if (canonical === 'pending') {
    actions = ['accept', 'reject'];
    if ((type === 'curation' || type === 'curation_rerate') && postFailed) {
      actions = ['retry_discord', ...actions];
    }
  } else if (canonical === 'accepted') {
    if (type === 'rerate') {
      actions = ['add_to_rating', 'discord_vote', 'complete', 'reject'];
    } else {
      actions = ['complete', 'reject'];
      if ((type === 'curation' || type === 'curation_rerate') && (!hasThread || postFailed)) {
        actions = ['retry_discord', ...actions];
      }
    }
  } else if (type === 'rerate' && canonical === 'added_to_rating_page' && !hasThread) {
    actions = ['discord_vote'];
  } else if (type === 'rerate' && canonical === 'discord_vote' && (!hasThread || postFailed)) {
    actions = ['retry_discord'];
  }
  if (hasThread && !threadClosed) actions = [...actions, 'delete_discord'];
  if (type === 'rerate' && hasThread && threadClosed) actions = [...actions, 'reopen_discord'];
  return actions;
}

/** Same separator rules as RatingUtils.parseRatingRange, with spaces around - and ~ removed first. */
export function normalizePguRequest(raw: string): string {
  return String(raw ?? '')
    .trim()
    .replace(/\s*([-~])\s*/g, '$1');
}

function parsePguParts(rating: string): string[] {
  const match = rating.match(/([^-~\s]+|^-\d+)([-~\s])(.+)/);
  if (!match) return [rating.trim()];
  const firstPart = match[1];
  const lastPart = match[3].trim();
  const firstMatch = firstPart.match(/([PGUpgu]*)(-?\d+)/);
  const lastMatch = lastPart.match(/([PGUpgu]*)(-?\d+)/);
  if (firstMatch && lastMatch && !lastMatch[1] && firstMatch[1]) {
    return [firstPart, `${firstMatch[1]}${lastMatch[2]}`];
  }
  return [firstPart, lastPart];
}

export function isRealPguRequest(raw: string | null | undefined): boolean {
  const input = normalizePguRequest(String(raw ?? ''));
  if (!input) return false;
  const parts = parsePguParts(input);
  if (parts.length < 1 || parts.length > 2) return false;
  return parts.every((part) => PGU_TOKEN.test(part.trim()));
}

function specialNameLookup(names: Iterable<string>): Map<string, string> {
  const lookup = new Map<string, string>();
  for (const name of names) {
    const value = String(name ?? '').trim();
    if (!value) continue;
    lookup.set(value.toLowerCase(), value);
  }
  return lookup;
}

/**
 * A PGU difficulty or range, or one special difficulty matched by its stored name.
 * Returns the value to save, with the special name in its stored casing.
 */
export function resolveRerateRating(raw: string | null | undefined, specialNames: Iterable<string> = []): string | null {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return null;
  const special = specialNameLookup(specialNames).get(trimmed.toLowerCase());
  if (special) return special;
  return isRealPguRequest(trimmed) ? normalizePguRequest(trimmed) : null;
}

/** `Artist - Song (suffix)` for rerate comparison errors. */
export function rerateComparisonLabel(artist: unknown, song: unknown, suffix: unknown): string {
  const artistPart = String(artist ?? '').trim() || 'Unknown';
  const songPart = String(song ?? '').trim() || 'Unknown';
  const extra = String(suffix ?? '').trim();
  if (!extra) return `${artistPart} - ${songPart}`;
  const wrapped = extra.startsWith('(') ? extra : `(${extra})`;
  return `${artistPart} - ${songPart} ${wrapped}`;
}

export function collectLevelReferenceIds(text: string): number[] {
  const source = typeof text === 'string' ? text : '';
  const pattern = /#(\d+)/gi;
  const ids: number[] = [];
  const seen = new Set<number>();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const levelId = parseInt(match[1], 10);
    if (!Number.isInteger(levelId) || levelId <= 0 || seen.has(levelId)) continue;
    seen.add(levelId);
    ids.push(levelId);
    if (ids.length >= LEVEL_REFERENCE_ID_LIMIT) break;
  }
  return ids;
}

export function rerateCooldownRemainingMs(resolvedAt: Date | string | null | undefined, now = Date.now()): number {
  if (!resolvedAt) return 0;
  const at = new Date(resolvedAt).getTime();
  if (Number.isNaN(at)) return 0;
  return Math.max(0, RERATE_COOLDOWN_MS - (now - at));
}

export const INFO_CHANGE_VALUE_MAX = 4000;

export const CREDIT_REQUEST_ROLES = ['charter', 'vfxer', 'specialThanks'] as const;
export type CreditRequestRole = (typeof CREDIT_REQUEST_ROLES)[number];

export type RequestCredit = {
  creatorId: number;
  role: CreditRequestRole;
  isOwner: boolean;
  sortOrder: number;
};

export type RequestTeam = {
  id: number | null;
  name: string;
};

export function canonicalRequestCredits(raw: unknown): RequestCredit[] | null {
  if (!Array.isArray(raw)) return null;
  const items: RequestCredit[] = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object') return null;
    const record = row as Record<string, unknown>;
    const creatorId = Number(record.creatorId ?? record.id);
    const role = String(record.role || '');
    if (!Number.isInteger(creatorId) || creatorId <= 0) return null;
    if (!CREDIT_REQUEST_ROLES.includes(role as CreditRequestRole)) return null;
    const sortOrder = Number(record.sortOrder);
    items.push({
      creatorId,
      role: role as CreditRequestRole,
      isOwner: record.isOwner === true || record.isOwner === 1,
      sortOrder: Number.isInteger(sortOrder) ? sortOrder : items.length,
    });
  }
  const ordered: RequestCredit[] = [];
  for (const role of CREDIT_REQUEST_ROLES) {
    items
      .filter((credit) => credit.role === role)
      .sort((left, right) => left.sortOrder - right.sortOrder || left.creatorId - right.creatorId)
      .forEach((credit, index) => {
        ordered.push({
          creatorId: credit.creatorId,
          role: credit.role,
          isOwner: credit.isOwner,
          sortOrder: index,
        });
      });
  }
  const keys = new Set(ordered.map((credit) => `${credit.creatorId}:${credit.role}`));
  if (keys.size !== ordered.length) return null;
  return ordered;
}

/** `undefined` means the team value is invalid. `null` means no team. */
export function requestTeamFromInput(raw: unknown): RequestTeam | null | undefined {
  if (raw == null || raw === '') return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const id = record.id == null || record.id === '' ? null : Number(record.id);
  if (id != null && (!Number.isInteger(id) || id <= 0)) return undefined;
  const name = String(record.name ?? '').trim();
  if (name.length > 255) return undefined;
  if (id == null && !name) return null;
  return {id, name};
}

export function creditRequestSignature(credits: RequestCredit[], team: RequestTeam | null): string {
  return JSON.stringify({
    team: team ? {id: team.id ?? null, name: team.name || ''} : null,
    credits: credits.map((credit) => [credit.creatorId, credit.role, credit.isOwner ? 1 : 0, credit.sortOrder]),
  });
}

export function completionStatusForDifficultyChange(
  frozenDiffId: number | null | undefined,
  settledDiffId: number | null | undefined,
): 'completed_changed' | 'completed_unchanged' {
  const frozen = frozenDiffId == null ? null : Number(frozenDiffId);
  const settled = settledDiffId == null || Number.isNaN(Number(settledDiffId)) ? null : Number(settledDiffId);
  return frozen !== settled ? 'completed_changed' : 'completed_unchanged';
}

/** Rating-page copy of a rerate reason, with the original requester on the last line. */
export function reasonWithRequester(reason: string, username: string): string {
  const handle = String(username || '').trim().replace(/^@+/, '');
  const base = String(reason || '').trim();
  if (!handle) return base;
  const line = `Requested by @${handle}`;
  if (base === line || base.endsWith(`\n${line}`)) return base;
  return base ? `${base}\n${line}` : line;
}

export type ParseResult<T> =
  | {ok: true; value: T}
  | {ok: false; code: string; message: string};

export type RerateScoreTargets = {
  baseScore?: number;
  ppBaseScore?: number;
  xaccCurveMeta?: Record<string, unknown>;
};

const CURVE_JUDGEMENT_KEYS = [
  'earlyDouble',
  'earlySingle',
  'ePerfect',
  'perfectMinus',
  'perfect',
  'perfectPlus',
  'lPerfect',
  'lateSingle',
  'lateDouble',
] as const;

function isBlankScoreInput(raw: unknown): boolean {
  return raw === undefined || raw === null || (typeof raw === 'string' && !raw.trim());
}

/** Optional non-negative finite number. Blank/null means the field is not requested. */
export function parseOptionalNonNegativeNumber(
  raw: unknown,
  code: string,
  label: string,
): ParseResult<number | undefined> {
  if (isBlankScoreInput(raw)) return {ok: true, value: undefined};
  const value = typeof raw === 'number' ? raw : Number(typeof raw === 'string' ? raw.trim() : raw);
  if (!Number.isFinite(value) || value < 0) {
    return {ok: false, code, message: `${label} must be a non-negative number`};
  }
  return {ok: true, value};
}

function parseOptionalFiniteNumber(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const value = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function parseOptionalPassId(raw: unknown): number | null {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function parseStoredJudgements(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  const judgements: Record<string, string> = {};
  for (const key of CURVE_JUDGEMENT_KEYS) {
    if (source[key] == null || source[key] === '') continue;
    const count = Number(source[key]);
    if (Number.isFinite(count) && count === 0) continue;
    judgements[key] = String(source[key]);
  }
  return Object.keys(judgements).length > 0 ? judgements : undefined;
}

function parseStoredCurvePin(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  const pin: Record<string, unknown> = {};
  const sourcePassId = parseOptionalPassId(source.sourcePassId);
  if (sourcePassId != null) pin.sourcePassId = sourcePassId;
  const judgements = parseStoredJudgements(source.judgements);
  if (judgements) pin.judgements = judgements;
  return Object.keys(pin).length > 0 ? pin : undefined;
}

function parseStoredCurveEditor(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  const editor: Record<string, unknown> = {
    pinInputMode: source.pinInputMode === 'judgements' ? 'judgements' : 'accuracy',
    disablePP: source.disablePP === true,
  };
  const accXDisplay = parseOptionalFiniteNumber(source.accXDisplay);
  const scoreXDisplay = parseOptionalFiniteNumber(source.scoreXDisplay);
  const accYDisplay = parseOptionalFiniteNumber(source.accYDisplay);
  const scoreYDisplay = parseOptionalFiniteNumber(source.scoreYDisplay);
  if (accXDisplay != null) editor.accXDisplay = accXDisplay;
  if (scoreXDisplay != null) editor.scoreXDisplay = scoreXDisplay;
  if (accYDisplay != null) editor.accYDisplay = accYDisplay;
  if (scoreYDisplay != null) editor.scoreYDisplay = scoreYDisplay;
  const pin1 = parseStoredCurvePin(source.pin1);
  const pin2 = parseStoredCurvePin(source.pin2);
  if (pin1) editor.pin1 = pin1;
  if (pin2) editor.pin2 = pin2;
  return editor;
}

function parseStoredCurvePins(raw: unknown): ParseResult<Record<string, unknown> | undefined> {
  if (raw == null) return {ok: true, value: undefined};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {ok: false, code: 'score_curve', message: 'Score curve pins must be an object'};
  }
  const source = raw as Record<string, unknown>;
  const accX = Number(source.accX);
  const accY = Number(source.accY);
  const scoreX = Number(source.scoreX);
  const scoreY = Number(source.scoreY);
  if (![accX, accY, scoreX, scoreY].every((value) => Number.isFinite(value))) {
    return {ok: false, code: 'score_curve', message: 'Score curve pins must include accuracy and score'};
  }
  if (accX <= 0 || accX > 1 || accY <= 0 || accY > 1 || scoreX < 0 || scoreY < 0) {
    return {ok: false, code: 'score_curve', message: 'Score curve pin values are out of range'};
  }
  const pins: Record<string, unknown> = {accX, accY, scoreX, scoreY};
  const multX = parseOptionalFiniteNumber(source.multX);
  const multY = parseOptionalFiniteNumber(source.multY);
  if (multX != null) pins.multX = multX;
  if (multY != null) pins.multY = multY;
  const missesX = parseOptionalFiniteNumber(source.missesX);
  const missesY = parseOptionalFiniteNumber(source.missesY);
  const hitTiles = parseOptionalFiniteNumber(source.hitTiles);
  if (missesX != null) pins.missesX = Math.max(0, Math.floor(missesX));
  if (missesY != null) pins.missesY = Math.max(0, Math.floor(missesY));
  if (hitTiles != null) pins.hitTiles = Math.max(0, Math.floor(hitTiles));
  if (source.scoresAreXaccMultipliers === true) pins.scoresAreXaccMultipliers = true;
  return {ok: true, value: pins};
}

/**
 * Optional requested xacc curve. Keeps the editor pin setup (passes, judgements,
 * accuracy, score) plus the derived hyperbola params. Blank/null means omitted.
 */
export function parseRerateXaccCurveMeta(raw: unknown): ParseResult<Record<string, unknown> | undefined> {
  if (isBlankScoreInput(raw)) return {ok: true, value: undefined};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {ok: false, code: 'score_curve', message: 'Score curve must be an object'};
  }
  const source = raw as Record<string, unknown>;
  const poleOffset = Number(source.poleOffset);
  const topMultiplier = Number(source.topMultiplier);
  if (!Number.isFinite(poleOffset) || poleOffset <= 0 || poleOffset >= 1) {
    return {ok: false, code: 'score_curve', message: 'Score curve pole offset (E) must be a positive number less than 1'};
  }
  if (!Number.isFinite(topMultiplier) || topMultiplier <= 1 || topMultiplier >= 1000) {
    return {ok: false, code: 'score_curve', message: 'Score curve top multiplier (G) must be greater than 1 and less than 1000'};
  }
  const pins = parseStoredCurvePins(source.pins);
  if (!pins.ok) return pins;
  if (!pins.value) {
    return {ok: false, code: 'score_curve', message: 'Score curve must include pin accuracy and score'};
  }
  const meta: Record<string, unknown> = {
    poleOffset,
    topMultiplier,
    pins: pins.value,
  };
  const cutoff = parseOptionalFiniteNumber(source.cutoff);
  if (cutoff != null) meta.cutoff = cutoff;
  const editor = parseStoredCurveEditor(source.editor);
  if (editor) meta.editor = editor;
  return {ok: true, value: meta};
}

export function parseRerateScoreTargets(body: Record<string, unknown>): ParseResult<RerateScoreTargets> {
  const baseScore = parseOptionalNonNegativeNumber(body.baseScore, 'base_score', 'Base score');
  if (!baseScore.ok) return baseScore;
  const ppBaseScore = parseOptionalNonNegativeNumber(body.ppBaseScore, 'pp_base_score', 'PP base score');
  if (!ppBaseScore.ok) return ppBaseScore;
  const xaccCurveMeta = parseRerateXaccCurveMeta(body.xaccCurveMeta);
  if (!xaccCurveMeta.ok) return xaccCurveMeta;
  const value: RerateScoreTargets = {};
  if (baseScore.value !== undefined) value.baseScore = baseScore.value;
  if (ppBaseScore.value !== undefined) value.ppBaseScore = ppBaseScore.value;
  if (xaccCurveMeta.value !== undefined) value.xaccCurveMeta = xaccCurveMeta.value;
  return {ok: true, value};
}

function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const rounded = Math.round(value * 1e6) / 1e6;
  return String(rounded);
}

function formatPinJudgements(raw: unknown): string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return '';
  const source = raw as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of CURVE_JUDGEMENT_KEYS) {
    const count = Number(source[key]);
    if (!Number.isFinite(count) || count === 0) continue;
    parts.push(`${key} ${formatCompactNumber(count)}`);
  }
  return parts.length ? `judgements ${parts.join(' ')}` : '';
}

function formatScoreCurvePinLine(
  index: 1 | 2,
  pins: Record<string, unknown>,
  editor: Record<string, unknown> | null,
): string | null {
  const accKey = index === 1 ? 'accX' : 'accY';
  const scoreKey = index === 1 ? 'scoreX' : 'scoreY';
  const acc = Number(pins[accKey]);
  const score = Number(pins[scoreKey]);
  if (!Number.isFinite(acc) || !Number.isFinite(score)) return null;
  const parts = [
    `Pin ${index}:`,
    `${formatCompactNumber(acc * 100)}%`,
    formatCompactNumber(score),
  ];
  const pin = (index === 1 ? editor?.pin1 : editor?.pin2) as Record<string, unknown> | undefined;
  const passId = parseOptionalPassId(pin?.sourcePassId);
  if (passId != null) parts.push(`pass #${passId}`);
  if (editor?.pinInputMode === 'judgements') {
    const judgements = formatPinJudgements(pin?.judgements);
    if (judgements) parts.push(judgements);
  }
  return parts.join(' ');
}

/** English lines for Discord embeds and rating-page rerate info. */
export function formatRerateScoreTargetLines(payload: Record<string, unknown> | null | undefined): string[] {
  if (!payload) return [];
  const lines: string[] = [];
  const baseScore = parseOptionalFiniteNumber(payload.baseScore);
  const ppBaseScore = parseOptionalFiniteNumber(payload.ppBaseScore);
  if (baseScore != null) lines.push(`Base score: ${formatCompactNumber(baseScore)}`);
  if (ppBaseScore != null) lines.push(`PP base score: ${formatCompactNumber(ppBaseScore)}`);
  const meta = payload.xaccCurveMeta;
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    const root = meta as Record<string, unknown>;
    const pins = root.pins && typeof root.pins === 'object' && !Array.isArray(root.pins)
      ? root.pins as Record<string, unknown>
      : null;
    const editor = root.editor && typeof root.editor === 'object' && !Array.isArray(root.editor)
      ? root.editor as Record<string, unknown>
      : null;
    lines.push('Score curve:');
    if (pins) {
      const pin1 = formatScoreCurvePinLine(1, pins, editor);
      const pin2 = formatScoreCurvePinLine(2, pins, editor);
      if (pin1) lines.push(pin1);
      if (pin2) lines.push(pin2);
    }
  }
  return lines;
}

export function appendRerateScoreTargetLines(
  reason: string,
  payload: Record<string, unknown> | null | undefined,
): string {
  const lines = formatRerateScoreTargetLines(payload);
  const base = String(reason || '').trim();
  if (!lines.length) return base;
  return base ? `${base}\n${lines.join('\n')}` : lines.join('\n');
}
