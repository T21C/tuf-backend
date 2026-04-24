import Creator from '@/models/credits/Creator.js';
import { CreatorAlias } from '@/models/credits/CreatorAlias.js';
import LevelCredit from '@/models/levels/LevelCredit.js';
import User from '@/models/auth/User.js';
import {
  runCreatorStatsQuery,
  CreatorStatsRow,
} from '@/server/services/elasticsearch/misc/creatorStatsQuery.js';
import { logger } from '@/server/services/core/LoggerService.js';

const RECENT_LEVELS_LIMIT = 5;

const ZERO_STATS: Omit<CreatorStatsRow, 'id'> = {
  chartsCharted: 0,
  chartsVfxed: 0,
  chartsTeamed: 0,
  chartsTotal: 0,
  totalChartClears: 0,
  totalChartLikes: 0,
};

export interface EnrichedCreator {
  creator: Creator | null;
  user: Pick<User, 'id' | 'username' | 'nickname' | 'avatarUrl' | 'playerId' | 'creatorId'> | null;
  aliases: Array<Pick<CreatorAlias, 'id' | 'name' | 'creatorId'>>;
  stats: Omit<CreatorStatsRow, 'id'>;
  recentLevelIds: number[];
}

/**
 * Service responsible for computing/serving creator-level statistics.
 *
 * The shape returned here is intentionally minimal but extensible — every future stat
 * (tournament placements, top-role icon, tiles placed, etc.) can be a pure addition
 * to {@link EnrichedCreator.stats} without touching call sites.
 *
 * Backed by the same SQL the indexer uses ({@link runCreatorStatsQuery}) so the
 * profile endpoint and the ES doc never disagree on counters.
 */
export class CreatorStatsService {
  private static instance: CreatorStatsService;

  private constructor() {}

  public static getInstance(): CreatorStatsService {
    if (!CreatorStatsService.instance) {
      CreatorStatsService.instance = new CreatorStatsService();
    }
    return CreatorStatsService.instance;
  }

  /**
   * Compute the stats block for a single creator.
   * Returns the zero block when the creator has no credits.
   */
  public async getCreatorStats(creatorId: number): Promise<Omit<CreatorStatsRow, 'id'>> {
    if (!Number.isFinite(creatorId) || creatorId <= 0) return { ...ZERO_STATS };
    const rows = await runCreatorStatsQuery({ creatorIds: [creatorId] });
    const row = rows.find((r) => Number(r.id) === creatorId);
    if (!row) return { ...ZERO_STATS };
    const { id: _id, ...rest } = row;
    return rest;
  }

  /**
   * Enriched view used by the v3 creator profile endpoint:
   *   - `creator` — DB row (null when missing)
   *   - `user`    — linked auth user (if any)
   *   - `aliases` — known aliases
   *   - `stats`   — same shape as `getCreatorStats`
   *   - `recentLevelIds` — last few levels the creator is credited on, freshness signal
   *      for the profile UI before the full level list loads.
   */
  public async getEnrichedCreator(creatorId: number): Promise<EnrichedCreator | null> {
    if (!Number.isFinite(creatorId) || creatorId <= 0) return null;

    try {
      const [creator, aliases, user, statsRows, recentCredits] = await Promise.all([
        Creator.findByPk(creatorId),
        CreatorAlias.findAll({ where: { creatorId } }),
        User.findOne({ where: { creatorId } }),
        runCreatorStatsQuery({ creatorIds: [creatorId] }),
        LevelCredit.findAll({
          where: { creatorId },
          attributes: ['levelId'],
          order: [['id', 'DESC']],
          limit: RECENT_LEVELS_LIMIT,
        }),
      ]);

      if (!creator) return null;

      const statsRow = statsRows.find((r) => Number(r.id) === creatorId);
      const stats = statsRow
        ? (() => {
            const { id: _id, ...rest } = statsRow;
            return rest;
          })()
        : { ...ZERO_STATS };

      const recentLevelIds = [
        ...new Set(
          recentCredits
            .map((c) => c.levelId)
            .filter((id): id is number => typeof id === 'number' && Number.isFinite(id) && id > 0),
        ),
      ];

      const aliasesPlain = aliases.map((a) => ({
        id: a.id,
        name: a.name,
        creatorId: a.creatorId,
      }));

      const userPlain = user
        ? {
            id: user.id,
            username: user.username,
            nickname: user.nickname ?? null,
            avatarUrl: user.avatarUrl ?? null,
            playerId: user.playerId as number,
            creatorId: user.creatorId ?? null,
          }
        : null;

      return {
        creator,
        user: userPlain as EnrichedCreator['user'],
        aliases: aliasesPlain,
        stats,
        recentLevelIds,
      };
    } catch (error) {
      logger.error(`Error enriching creator ${creatorId}:`, error);
      return null;
    }
  }

  /**
   * Bulk variant of {@link getCreatorStats} — useful when the creator listing UI
   * wants to display per-row stats without a round-trip per creator.
   */
  public async getCreatorStatsBulk(
    creatorIds: number[],
  ): Promise<Map<number, Omit<CreatorStatsRow, 'id'>>> {
    const out = new Map<number, Omit<CreatorStatsRow, 'id'>>();
    const ids = [...new Set(creatorIds)].filter((id) => Number.isFinite(id) && id > 0);
    if (ids.length === 0) return out;

    const rows = await runCreatorStatsQuery({ creatorIds: ids });
    for (const row of rows) {
      const { id, ...rest } = row;
      out.set(Number(id), rest);
    }
    // Fill missing creators with zeros.
    for (const id of ids) {
      if (!out.has(id)) out.set(id, { ...ZERO_STATS });
    }
    return out;
  }
}

export default CreatorStatsService;
