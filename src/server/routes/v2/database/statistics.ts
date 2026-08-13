import {Router, Request, Response} from 'express';
import { ApiDoc } from '@/server/middleware/apiDoc.js';
import { standardErrorResponses500 } from '@/server/schemas/v2/database/index.js';
import {Op, fn, col, literal, QueryTypes} from 'sequelize';
import sequelize from '@/config/db.js';
import Level from '@/models/levels/Level.js';
import Pass from '@/models/passes/Pass.js';
import Player from '@/models/players/Player.js';
import LevelSubmission from '@/models/submissions/LevelSubmission.js';
import {PassSubmission} from '@/models/submissions/PassSubmission.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { Cache } from '@/server/middleware/cache.js';

const router: Router = Router();

type CountRow = { cnt: number | string };
type DifficultyStatRow = {
  id: number;
  name: string;
  type: string;
  sortOrder: number;
  color: string;
  levelCount: number | string;
  passCount: number | string;
};

function toCount(value: number | string | undefined): number {
  return Number(value ?? 0);
}

// Tags: `levels:all` + `Passes` are invalidated from Level/Pass hooks (models/levels/hooks.ts).
// Submission queue counts are not on those hooks; they refresh at TTL or if something invalidates `database:statistics`.
router.get(
  '/',
  Cache({
    ttl: 300,
    prefix: 'database:statistics',
    tags: ['database:statistics', 'levels:all', 'Passes'],
  }),
  ApiDoc({
    operationId: 'getStatistics',
    summary: 'Overall statistics',
    description:
      'Returns overview stats: total levels, passes, players, difficulties, submissions. Cached; invalidated via tags `levels:all` and `Passes` (same as level/pass HTTP caches). Pending submission counts may lag until TTL.',
    tags: ['Database', 'Statistics'],
    responses: { 200: { description: 'Statistics object' }, ...standardErrorResponses500 },
  }),
  async (req: Request, res: Response) => {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [
      totalLevels,
      totalPasses,
      totalPlayers,
      activePlayerRows,
      difficultyRows,
      recentPassStats,
      pendingLevels,
      pendingPassSubmissions,
      totalPassSubmissions,
    ] = await Promise.all([
      Level.count({where: {isDeleted: false, isHidden: false}}),
      Pass.count({where: {isDeleted: false, isHidden: false}}),
      Player.count(),
      sequelize.query<CountRow>(
        `SELECT COUNT(DISTINCT p.playerId) AS cnt
         FROM passes p
         WHERE p.isDeleted = 0`,
        {type: QueryTypes.SELECT},
      ),
      // Aggregates only: GROUP BY counts, never join levels×passes into one result set.
      sequelize.query<DifficultyStatRow>(
        `SELECT
           d.id,
           d.name,
           d.type,
           d.sortOrder,
           d.color,
           COALESCE(lc.cnt, 0) AS levelCount,
           COALESCE(pc.cnt, 0) AS passCount
         FROM difficulties d
         LEFT JOIN (
           SELECT diffId, COUNT(*) AS cnt
           FROM levels
           GROUP BY diffId
         ) lc ON lc.diffId = d.id
         LEFT JOIN (
           SELECT l.diffId AS diffId, COUNT(*) AS cnt
           FROM passes p
           INNER JOIN levels l ON l.id = p.levelId
           WHERE p.isDeleted = 0
           GROUP BY l.diffId
         ) pc ON pc.diffId = d.id
         ORDER BY d.sortOrder ASC`,
        {type: QueryTypes.SELECT},
      ),
      Pass.count({
        where: {
          isDeleted: false,
          vidUploadTime: {[Op.gte]: thirtyDaysAgo},
        },
      }),
      LevelSubmission.count({where: {status: 'pending'}}),
      PassSubmission.count({where: {status: 'pending'}}),
      PassSubmission.count(),
    ]);

    const difficultyStats = difficultyRows.map(row => ({
      id: row.id,
      name: row.name,
      type: row.type,
      sortOrder: row.sortOrder,
      color: row.color,
      levelCount: toCount(row.levelCount),
      passCount: toCount(row.passCount),
    }));

    const byType = difficultyStats.reduce(
      (acc, diff) => {
        const type = diff.type;
        if (!acc[type]) {
          acc[type] = [];
        }
        acc[type].push(diff);
        return acc;
      },
      {} as Record<string, typeof difficultyStats>,
    );

    const top = [...difficultyStats]
      .filter(diff => diff.passCount > 0)
      .sort((a, b) => b.passCount - a.passCount)
      .slice(0, 5);

    return res.json({
      overview: {
        totalLevels,
        totalPasses,
        totalPlayers,
        totalActivePlayers: toCount(activePlayerRows[0]?.cnt),
        passesLast30Days: recentPassStats,
      },
      difficulties: {
        all: difficultyStats,
        byType,
        top,
      },
      submissions: {
        pendingLevels,
        passes: {
          pending: pendingPassSubmissions,
          total: totalPassSubmissions,
        },
      },
    });
  } catch (error) {
    logger.error('Error fetching statistics:', error);
    return res.status(500).json({
      error: 'Failed to fetch statistics',
      details: error instanceof Error ? error.message : String(error),
    });
  }
  }
);

// Same hook-driven tags as overview; player/pass aggregates update when passes or levels change.
router.get(
  '/players',
  Cache({
    ttl: 300,
    prefix: 'database:statistics:players',
    tags: ['database:statistics:players', 'levels:all', 'Passes'],
  }),
  ApiDoc({
    operationId: 'getStatisticsPlayers',
    summary: 'Player statistics',
    description:
      'Returns player stats: by country, top players by passes. Cached; invalidated via `levels:all` and `Passes` from level/pass hooks.',
    tags: ['Database', 'Statistics'],
    responses: { 200: { description: 'Player statistics' }, ...standardErrorResponses500 },
  }),
  async (req: Request, res: Response) => {
  try {
    const [playerCountByCountry, topPlayersByPasses] = await Promise.all([
      // Players by country
      Player.findAll({
        attributes: ['country', [fn('COUNT', col('id')), 'playerCount']],
        group: ['country'],
        order: [[literal('playerCount'), 'DESC']],
      }),

      // Top players by number of passes (subQuery: false — avoid invalid COUNT(passes.id) in subselect)
      Player.findAll({
        attributes: [
          'id',
          'name',
          'country',
          [fn('COUNT', col('passes.playerId')), 'passCount'],
        ],
        include: [
          {
            model: Pass,
            as: 'passes',
            attributes: [],
            where: {isDeleted: false},
            required: true,
          },
        ],
        group: ['Player.id', 'Player.name', 'Player.country'],
        order: [[literal('passCount'), 'DESC']],
        limit: 10,
        subQuery: false,
      }),
    ]);

    return res.json({
      countryStats: playerCountByCountry.map(stat => ({
        country: stat.country,
        playerCount: Number(stat.get('playerCount')),
      })),
      topPassers: topPlayersByPasses.map(player => ({
        name: player.name,
        country: player.country,
        passCount: Number(player.get('passCount')),
      })),
    });
  } catch (error) {
    logger.error('Error fetching player statistics:', error);
    return res.status(500).json({
      error: 'Failed to fetch player statistics',
      details: error instanceof Error ? error.message : String(error),
    });
  }
  }
);

export default router;
