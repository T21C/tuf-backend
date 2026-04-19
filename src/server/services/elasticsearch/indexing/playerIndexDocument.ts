import Player from '@/models/players/Player.js';
import User from '@/models/auth/User.js';
import Creator from '@/models/credits/Creator.js';
import OAuthProvider from '@/models/auth/OAuthProvider.js';
import Difficulty from '@/models/levels/Difficulty.js';
import type { PlayerStatsRow } from '@/server/services/elasticsearch/misc/playerStatsQuery.js';

export interface PlayerIndexDocumentInput {
  player: Player;
  user?: User | null;
  discordProvider?: OAuthProvider | null;
  topDiff?: Difficulty | null;
  top12kDiff?: Difficulty | null;
  stats?: Partial<PlayerStatsRow> | null;
}

function plain<T extends object | null | undefined>(m: T): Record<string, unknown> | null {
  if (!m) return null;
  const anyM = m as unknown as { get?: (opts: { plain: true }) => unknown };
  if (typeof anyM.get === 'function') {
    return anyM.get({ plain: true }) as Record<string, unknown>;
  }
  return { ...(m as Record<string, unknown>) };
}

function coerceNumber(value: unknown, fallback = 0): number {
  if (value == null) return fallback;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function serializeDifficulty(diff: Difficulty | null | undefined): any | null {
  if (!diff) return null;
  const p = plain(diff) as any;
  if (!p) return null;
  return {
    id: coerceNumber(p.id, 0),
    name: p.name ?? null,
    type: p.type ?? null,
    sortOrder: coerceNumber(p.sortOrder, 0),
    baseScore: coerceNumber(p.baseScore, 0),
    icon: p.icon ?? null,
    emoji: p.emoji ?? null,
    color: p.color ?? null,
    legacyIcon: p.legacyIcon ?? null,
    legacyEmoji: p.legacyEmoji ?? null,
  };
}

function serializeDiscord(provider: OAuthProvider | null | undefined): any | null {
  if (!provider) return null;
  const p = plain(provider) as any;
  const profile = (p?.profile ?? {}) as any;
  return {
    providerId: p.providerId ? String(p.providerId) : null,
    username: profile?.username ?? null,
  };
}

function permissionFlagsToLong(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (typeof value === 'number') return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function serializeCreator(creator: Creator | null | undefined): Record<string, unknown> | null {
  if (!creator) return null;
  const c = plain(creator) as any;
  if (c?.id == null) return null;
  const status = typeof c.verificationStatus === 'string' ? c.verificationStatus : 'allowed';
  return {
    id: coerceNumber(c.id, 0),
    name: c.name ?? '',
    verificationStatus: status,
  };
}

function serializeUser(user: User | null | undefined): any | null {
  if (!user) return null;
  const u = plain(user) as any;
  return {
    id: u.id ?? null,
    username: u.username ?? null,
    nickname: u.nickname ?? null,
    avatarUrl: u.avatarUrl ?? null,
    permissionFlags: permissionFlagsToLong(u.permissionFlags),
    permissionVersion: coerceNumber(u.permissionVersion, 0),
    isEmailVerified: Boolean(u.isEmailVerified),
    creator: u.creatorId != null ? serializeCreator(user.creator) : null,
  };
}

/**
 * Build the Elasticsearch document for a single player.
 *
 * All derived stats come from {@link PlayerStatsRow}. Pass in `stats: null` to produce a
 * zero-stats document (e.g. freshly registered player with no passes yet).
 */
export function buildPlayerIndexDocument(input: PlayerIndexDocumentInput): Record<string, unknown> {
  const { player, topDiff, top12kDiff } = input;
  const p = plain(player) as any;
  const stats = input.stats ?? null;

  const pfp = (() => {
    const userAvatar = input.user?.avatarUrl;
    if (typeof userAvatar === 'string' && userAvatar.length > 0) return userAvatar;
    if (typeof p.pfp === 'string' && p.pfp.length > 0) return p.pfp;
    return null;
  })();

  return {
    id: coerceNumber(p.id, 0),
    name: p.name ?? '',
    country: p.country ?? null,
    isBanned: Boolean(p.isBanned),
    isSubmissionsPaused: Boolean(p.isSubmissionsPaused),
    pfp,
    createdAt: p.createdAt ?? null,
    updatedAt: p.updatedAt ?? null,

    user: serializeUser(input.user ?? null),
    discord: serializeDiscord(input.discordProvider ?? null),

    rankedScore: coerceNumber(stats?.rankedScore, 0),
    generalScore: coerceNumber(stats?.generalScore, 0),
    ppScore: coerceNumber(stats?.ppScore, 0),
    wfScore: coerceNumber(stats?.wfScore, 0),
    score12K: coerceNumber(stats?.score12K, 0),
    averageXacc: coerceNumber(stats?.averageXacc, 0),
    universalPassCount: coerceNumber(stats?.universalPassCount, 0),
    worldsFirstCount: coerceNumber(stats?.worldsFirstCount, 0),
    totalPasses: coerceNumber(stats?.totalPasses, 0),

    topDiffId: coerceNumber(stats?.topDiffId, 0),
    top12kDiffId: coerceNumber(stats?.top12kDiffId, 0),
    topDiffSortOrder: coerceNumber(topDiff?.sortOrder, 0),
    top12kDiffSortOrder: coerceNumber(top12kDiff?.sortOrder, 0),
    topDiff: serializeDifficulty(topDiff ?? null),
    top12kDiff: serializeDifficulty(top12kDiff ?? null),

    statsUpdatedAt: new Date(),
  };
}
