import Creator from '@/models/credits/Creator.js';
import { CreatorAlias } from '@/models/credits/CreatorAlias.js';
import User from '@/models/auth/User.js';
import type { CreatorStatsRow } from '@/server/services/elasticsearch/misc/creatorStatsQuery.js';
import { validCreatorVerificationStatuses, type CreatorVerificationStatus } from '@/config/constants.js';

export interface CreatorIndexDocumentInput {
  creator: Creator;
  user?: User | null;
  aliases?: CreatorAlias[] | null;
  stats?: Partial<CreatorStatsRow> | null;
  /** Distinct credited levels per curation type id (string keys), same shape as profile `curationTypeCounts`. */
  curationTypeCounts?: Record<string, number> | null;
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

function serializeAliases(aliases: CreatorAlias[] | null | undefined): Array<{ id: number; name: string }> {
  if (!aliases || aliases.length === 0) return [];
  return aliases
    .map((a) => plain(a) as any)
    .filter((a) => a && typeof a.name === 'string')
    .map((a) => ({
      id: coerceNumber(a.id, 0),
      name: a.name,
    }));
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

function serializeDisplayCurationTypeIds(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const out: number[] = [];
  const seen = new Set<number>();
  for (const x of raw) {
    const n = Number(x);
    if (!Number.isFinite(n) || n <= 0 || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
    if (out.length >= 5) break;
  }
  return out;
}

function curationCountsToPairs(counts: Record<string, number> | null | undefined): Array<{ typeId: number; count: number }> {
  if (!counts || typeof counts !== 'object') return [];
  return Object.entries(counts)
    .map(([k, v]) => ({ typeId: Number(k), count: Number(v) || 0 }))
    .filter((x) => Number.isFinite(x.typeId) && x.typeId > 0 && x.count > 0)
    .sort((a, b) => a.typeId - b.typeId);
}

function serializeUser(user: User | null | undefined): any | null {
  if (!user) return null;
  const u = plain(user) as any;
  return {
    id: u.id ?? null,
    username: u.username ?? null,
    nickname: u.nickname ?? null,
    avatarUrl: u.avatarUrl ?? null,
    playerId: coerceNumber(u.playerId, 0),
    permissionFlags: permissionFlagsToLong(u.permissionFlags),
  };
}

/**
 * Build the Elasticsearch document for a single creator.
 *
 * All derived stats come from {@link CreatorStatsRow}. Pass in `stats: null` to produce a
 * zero-stats document (e.g. freshly created creator with no credits yet).
 */
export function buildCreatorIndexDocument(input: CreatorIndexDocumentInput): Record<string, unknown> {
  const { creator } = input;
  const c = plain(creator) as any;
  const stats = input.stats ?? null;
  const curationCounts = input.curationTypeCounts ?? {};

  const rawStatus = c.verificationStatus;
  const verificationStatus: CreatorVerificationStatus =
    typeof rawStatus === 'string' &&
    (validCreatorVerificationStatuses as readonly string[]).includes(rawStatus)
      ? (rawStatus as CreatorVerificationStatus)
      : 'allowed';

  return {
    id: coerceNumber(c.id, 0),
    name: c.name ?? '',
    verificationStatus,
    bio: typeof c.bio === 'string' && c.bio.trim().length ? c.bio : null,
    uploadConditions:
      typeof c.uploadConditions === 'string' && c.uploadConditions.trim().length
        ? c.uploadConditions.trim()
        : null,
    bannerPreset: typeof c.bannerPreset === 'string' && c.bannerPreset.length ? c.bannerPreset : null,
    customBannerId: typeof c.customBannerId === 'string' && c.customBannerId.length ? c.customBannerId : null,
    customBannerUrl: typeof c.customBannerUrl === 'string' && c.customBannerUrl.length ? c.customBannerUrl : null,
    aliases: serializeAliases(input.aliases ?? creator.creatorAliases ?? null),
    user: serializeUser(input.user ?? null),

    chartsCharted: coerceNumber(stats?.chartsCharted, 0),
    chartsVfxed: coerceNumber(stats?.chartsVfxed, 0),
    chartsTeamed: coerceNumber(stats?.chartsTeamed, 0),
    chartsTotal: coerceNumber(stats?.chartsTotal, 0),
    totalChartClears: coerceNumber(stats?.totalChartClears, 0),
    totalChartLikes: coerceNumber(stats?.totalChartLikes, 0),
    // Placeholder for the C/O/V/H "highest role" icon (computed by a follow-up).
    topRole: null,

    /** Nested pairs avoid ES dynamic field explosion from arbitrary curation type id keys. */
    curationTypeCountPairs: curationCountsToPairs(curationCounts),
    displayCurationTypeIds: serializeDisplayCurationTypeIds(c.displayCurationTypeIds),

    createdAt: c.createdAt ?? null,
    updatedAt: c.updatedAt ?? null,
    statsUpdatedAt: new Date(),
  };
}
