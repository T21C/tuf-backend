import {permissionFlags} from '@/config/constants.js';
import {UNSERIESED_SORT_WEIGHT, resolveEffectiveRowMode} from './placementModeUtils.js';
import type {TournamentPlacementMode} from '@/models/tournaments/Tournament.js';
import type {PlacementRowMode} from '@/models/tournaments/TournamentPlacement.js';

export const PUBLIC_TOURNAMENT_STATUSES = ['ongoing', 'completed', 'cancelled'] as const;
export type PublicTournamentStatus = (typeof PUBLIC_TOURNAMENT_STATUSES)[number];

export function parseHashIdSearch(search: string): number | null {
  const match = /^#(\d{1,20})$/.exec(String(search || '').trim());
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isFinite(id) && id > 0 ? id : null;
}

export function parsePublicTournamentStatus(raw: unknown): PublicTournamentStatus | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if ((PUBLIC_TOURNAMENT_STATUSES as readonly string[]).includes(value)) {
    return value as PublicTournamentStatus;
  }
  return null;
}

export function isPubliclyListedTournament(tournament: {
  isHidden?: boolean | null;
  status?: string | null;
} | null | undefined): boolean {
  if (!tournament) return false;
  return !tournament.isHidden && tournament.status !== 'draft';
}

function normalizeOwnerUserIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .map(id => String(id ?? '').trim())
        .filter(id => id.length > 0),
    ),
  ];
}

function userHasSuperAdmin(user: {permissionFlags?: unknown} | null | undefined): boolean {
  if (!user) return false;
  try {
    const flags = user.permissionFlags;
    const asFlags =
      typeof flags === 'string' ||
      typeof flags === 'number' ||
      typeof flags === 'bigint' ||
      typeof flags === 'boolean'
        ? flags
        : 0;
    return (BigInt(asFlags) & permissionFlags.SUPER_ADMIN) !== 0n;
  } catch {
    return false;
  }
}

export function canViewTournamentDetail(
  tournament: {
    isHidden?: boolean | null;
    status?: string | null;
    ownerUserIds?: unknown;
  } | null | undefined,
  user: {id?: string | null; permissionFlags?: unknown} | null | undefined,
): boolean {
  if (isPubliclyListedTournament(tournament)) return true;
  if (!tournament || !user) return false;
  if (userHasSuperAdmin(user)) return true;
  const owners = normalizeOwnerUserIds(tournament.ownerUserIds);
  return Boolean(user.id && owners.includes(String(user.id)));
}

export function canEditPublicTournament(
  tournament: {ownerUserIds?: unknown} | null | undefined,
  user: {id?: string | null; permissionFlags?: unknown} | null | undefined,
): boolean {
  if (!tournament || !user) return false;
  if (userHasSuperAdmin(user)) return true;
  const owners = normalizeOwnerUserIds(tournament.ownerUserIds);
  return Boolean(user.id && owners.includes(String(user.id)));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  if (typeof (value as {toJSON?: () => unknown}).toJSON === 'function') {
    const json = (value as {toJSON: () => unknown}).toJSON();
    return json && typeof json === 'object' ? (json as Record<string, unknown>) : null;
  }
  return value as Record<string, unknown>;
}

function numOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function serializePublicSeries(series: unknown) {
  const row = asRecord(series);
  if (!row || row.id == null) return null;
  return {
    id: Number(row.id),
    slug: String(row.slug || ''),
    name: String(row.name || ''),
    logoUrl: (row.logoUrl as string | null) ?? null,
    sortWeight: Number(row.sortWeight ?? 0) || 0,
  };
}

function strOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function nestedAvatarUrl(value: unknown): string | null {
  const row = asRecord(value);
  return row ? strOrNull(row.avatarUrl) : null;
}

function serializeNamedRef(value: unknown): {
  id: number;
  name: string | null;
  pfp: string | null;
  avatarUrl: string | null;
} | null {
  const row = asRecord(value);
  if (!row || row.id == null) return null;
  return {
    id: Number(row.id),
    name: row.name == null ? null : String(row.name),
    pfp: strOrNull(row.pfp),
    avatarUrl:
      strOrNull(row.avatarUrl) || nestedAvatarUrl(row.user) || nestedAvatarUrl(row.linkedUser),
  };
}

export function serializePublicTier(tier: unknown) {
  const row = asRecord(tier);
  if (!row || row.id == null) return null;
  return {
    id: Number(row.id),
    tournamentId: numOrNull(row.tournamentId),
    code: String(row.code || ''),
    label: String(row.label || ''),
    kind: String(row.kind || 'custom'),
    rankWeight: Number(row.rankWeight ?? 0) || 0,
    color: (row.color as string | null) ?? null,
    iconKey: (row.iconKey as string | null) ?? null,
    iconAssetId: (row.iconAssetId as string | null) ?? null,
    iconUrl: (row.iconUrl as string | null) ?? null,
    cardBackgroundAssetId: (row.cardBackgroundAssetId as string | null) ?? null,
    cardBackgroundUrl: (row.cardBackgroundUrl as string | null) ?? null,
    sortOrder: Number(row.sortOrder ?? 0) || 0,
  };
}

function serializePublicCredit(credit: unknown) {
  const row = asRecord(credit);
  if (!row || row.id == null) return null;
  return {
    id: Number(row.id),
    playerId: numOrNull(row.playerId),
    creatorId: numOrNull(row.creatorId),
    isGuest: Boolean(row.isGuest),
    sortOrder: Number(row.sortOrder ?? 0) || 0,
    player: serializeNamedRef(row.player),
    creator: serializeNamedRef(row.creator),
  };
}

export function serializePublicPlacement(
  placement: unknown,
  tournamentMode: TournamentPlacementMode = 'profile',
) {
  const row = asRecord(placement);
  if (!row || row.id == null) return null;
  const level = asRecord(row.level);
  const credits = Array.isArray(row.credits)
    ? row.credits.map(serializePublicCredit).filter(Boolean)
    : [];
  const rowMode = (row.rowMode === 'level' || row.rowMode === 'profile'
    ? row.rowMode
    : null) as PlacementRowMode | null;
  const effectiveRowMode = resolveEffectiveRowMode(rowMode, tournamentMode);

  return {
    id: Number(row.id),
    displayName: String(row.displayName || ''),
    playerId: numOrNull(row.playerId),
    creatorId: numOrNull(row.creatorId),
    player: serializeNamedRef(row.player),
    creator: serializeNamedRef(row.creator),
    withdrew: Boolean(row.withdrew),
    isPending: Boolean(row.isPending),
    teamKey: (row.teamKey as string | null) ?? null,
    teamName: (row.teamName as string | null) ?? null,
    positionInTier: Number(row.positionInTier ?? 0) || 0,
    rowMode,
    effectiveRowMode,
    levelId: numOrNull(row.levelId),
    level: level
      ? {
          id: Number(level.id),
          song: (level.song as string | null) ?? null,
          artist: (level.artist as string | null) ?? null,
          diffId: numOrNull(level.diffId),
        }
      : null,
    creditedCreatorIds: Array.isArray(row.creditedCreatorIds)
      ? row.creditedCreatorIds.map(Number).filter(n => Number.isFinite(n) && n > 0)
      : null,
    credits,
    tierId: numOrNull(row.tierId),
    tier: serializePublicTier(row.tier),
  };
}

export function serializePublicReward(reward: unknown) {
  const row = asRecord(reward);
  if (!row || row.id == null) return null;
  return {
    id: Number(row.id),
    tournamentId: numOrNull(row.tournamentId),
    seriesId: numOrNull(row.seriesId),
    tierId: numOrNull(row.tierId),
    maxRankWeight: numOrNull(row.maxRankWeight),
    requireNotWithdrew: Boolean(row.requireNotWithdrew),
    requireFinalResults: Boolean(row.requireFinalResults),
    rewardType: String(row.rewardType || ''),
    assetId: (row.assetId as string | null) ?? null,
    assetUrl: (row.assetUrl as string | null) ?? null,
    config: row.config && typeof row.config === 'object' ? row.config : null,
    label: String(row.label || ''),
    priority: Number(row.priority ?? 0) || 0,
  };
}

export function serializePublicOwner(owner: unknown) {
  const row = asRecord(owner);
  if (!row || row.id == null) return null;
  return {
    id: String(row.id),
    username: (row.username as string | null) ?? null,
    nickname: (row.nickname as string | null) ?? null,
    avatarUrl: (row.avatarUrl as string | null) ?? null,
  };
}

export function serializePublicTournamentCard(
  tournament: unknown,
  placementCount = 0,
) {
  const row = asRecord(tournament);
  if (!row || row.id == null) return null;
  return {
    id: Number(row.id),
    shortName: String(row.shortName || ''),
    fullName: (row.fullName as string | null) ?? null,
    aka: (row.aka as string | null) ?? null,
    status: String(row.status || 'draft'),
    track: row.track === 'creator' ? 'creator' : 'player',
    isResultsFinal: Boolean(row.isResultsFinal),
    seriesId: numOrNull(row.seriesId),
    series: serializePublicSeries(row.series),
    seriesSortWeight: Number(row.series ? asRecord(row.series)?.sortWeight ?? UNSERIESED_SORT_WEIGHT : UNSERIESED_SORT_WEIGHT) || UNSERIESED_SORT_WEIGHT,
    sortYear: numOrNull(row.sortYear),
    sortWeight: Number(row.sortWeight ?? 0) || 0,
    startsAt: row.startsAt ?? null,
    endsAt: row.endsAt ?? null,
    packRef: (row.packRef as string | null) ?? null,
    iconUrl: (row.iconUrl as string | null) ?? null,
    placementCount: Number(placementCount) || 0,
  };
}

export function serializePublicTournamentDetail(
  tournament: unknown,
  options: {owners?: unknown[]; canEdit?: boolean} = {},
) {
  const row = asRecord(tournament);
  if (!row || row.id == null) return null;
  const placementMode: TournamentPlacementMode =
    row.placementMode === 'level' ? 'level' : 'profile';
  const organizers = Array.isArray(row.organizers)
    ? row.organizers.map(value => String(value)).filter(Boolean)
    : [];

  return {
    id: Number(row.id),
    shortName: String(row.shortName || ''),
    fullName: (row.fullName as string | null) ?? null,
    aka: (row.aka as string | null) ?? null,
    seriesId: numOrNull(row.seriesId),
    series: serializePublicSeries(row.series),
    status: String(row.status || 'draft'),
    isHidden: Boolean(row.isHidden),
    isResultsFinal: Boolean(row.isResultsFinal),
    youtubeUrl: (row.youtubeUrl as string | null) ?? null,
    packRef: (row.packRef as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    externalUrl: (row.externalUrl as string | null) ?? null,
    organizers,
    ownerUserIds: normalizeOwnerUserIds(row.ownerUserIds),
    owners: (options.owners || []).map(serializePublicOwner).filter(Boolean),
    startsAt: row.startsAt ?? null,
    endsAt: row.endsAt ?? null,
    sortYear: numOrNull(row.sortYear),
    sortWeight: Number(row.sortWeight ?? 0) || 0,
    track: row.track === 'creator' ? 'creator' : 'player',
    placementMode,
    showBestTiersOnly: row.showBestTiersOnly !== false,
    cardLayoutDefault: String(row.cardLayoutDefault || 'classic'),
    creditRoleFilter: Array.isArray(row.creditRoleFilter) ? row.creditRoleFilter : null,
    iconAssetId: (row.iconAssetId as string | null) ?? null,
    iconUrl: (row.iconUrl as string | null) ?? null,
    cardBackgroundAssetId: (row.cardBackgroundAssetId as string | null) ?? null,
    cardBackgroundUrl: (row.cardBackgroundUrl as string | null) ?? null,
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
    canEdit: Boolean(options.canEdit),
    tiers: Array.isArray(row.tiers)
      ? row.tiers.map(serializePublicTier).filter(Boolean)
      : [],
    placements: Array.isArray(row.placements)
      ? row.placements.map(item => serializePublicPlacement(item, placementMode)).filter(Boolean)
      : [],
    rewards: Array.isArray(row.rewards)
      ? row.rewards.map(serializePublicReward).filter(Boolean)
      : [],
  };
}
