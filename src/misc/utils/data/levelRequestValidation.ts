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
  flags?: {discordMessageUrl?: string | null; discordPostError?: string | null},
): LevelRequestAction[] {
  const canonical = canonicalLevelRequestStatus(status);
  if (!canonical) return [];
  const hasThread = Boolean(flags?.discordMessageUrl);
  const postFailed = Boolean(flags?.discordPostError);
  if (canonical === 'pending') return ['accept', 'reject'];
  if (canonical === 'accepted') {
    if (type === 'rerate') return ['add_to_rating', 'discord_vote', 'complete', 'reject'];
    const actions: LevelRequestAction[] = ['complete', 'reject'];
    if ((type === 'curation' || type === 'curation_rerate') && (!hasThread || postFailed)) {
      return ['retry_discord', ...actions];
    }
    return actions;
  }
  if (type !== 'rerate') return [];
  if (canonical === 'added_to_rating_page' && !hasThread) {
    return ['discord_vote'];
  }
  if (canonical === 'discord_vote' && (!hasThread || postFailed)) {
    return ['retry_discord'];
  }
  return [];
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
