import {Router, Request, Response} from 'express';
import { ApiDoc } from '@/server/middleware/apiDoc.js';
import { standardErrorResponses500 } from '@/server/schemas/v2/database/index.js';
import {Op, fn, col, literal, Sequelize} from 'sequelize';
import Level from '@/models/levels/Level.js';
import Pass from '@/models/passes/Pass.js';
import Player from '@/models/players/Player.js';
import Difficulty from '@/models/levels/Difficulty.js';
import LevelSubmission from '@/models/submissions/LevelSubmission.js';
import {PassSubmission} from '@/models/submissions/PassSubmission.js';
import { logger } from '@/server/services/LoggerService.js';
import { Cache } from '@/server/middleware/cache.js';

const router: Router = Router();

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
    try {
      const totalLevels = await Level.count({
        where: {isDeleted: false, isHidden: false},
      });

      const totalPasses = await Pass.count({
        where: {isDeleted: false, isHidden: false},
      });

      const totalPlayers = await Player.count();

      const totalActivePlayers = await Player.count({
        include: [
          {
            model: Pass,
            as: 'passes',
            required: true,
            where: {isDeleted: false},
            limit: 1,
          },
        ],
      });

      const difficultyStats = await Difficulty.findAll({
        attributes: [
          'id',
          'name',
          'type',
          'sortOrder',
          'color',
          [
            fn('COUNT', Sequelize.fn('DISTINCT', col('levels.id'))),
            'levelCount',
          ],
          [fn('COUNT', col('levels.passes.id')), 'passCount'],
        ],
        include: [
          {
            model: Level,
            as: 'levels',
            attributes: [],
            required: false,
            include: [
              {
                model: Pass,
                as: 'passes',
                attributes: [],
                where: {isDeleted: false},
                required: false,
              },
            ],
          },
        ],
        group: [
          'Difficulty.id',
          'Difficulty.name',
          'Difficulty.type',
          'Difficulty.sortOrder',
          'Difficulty.color',
        ],
        order: [['sortOrder', 'ASC']],
        subQuery: false,
      });

      const recentPassStats = await Pass.count({
        where: {
          isDeleted: false,
          vidUploadTime: {
            [Op.gte]: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
          },
        },
      });

      const topDifficulties = await Difficulty.findAll({
        attributes: [
          'id',
          'name',
          'type',
          'sortOrder',
          'color',
          [
            fn('COUNT', Sequelize.fn('DISTINCT', col('levels.id'))),
            'levelCount',
          ],
          [fn('COUNT', col('levels.passes.id')), 'passCount'],
        ],
        include: [
          {
            model: Level,
            as: 'levels',
            attributes: [],
            required: true,
            include: [
              {
                model: Pass,
                as: 'passes',
                attributes: [],
                where: {isDeleted: false},
                required: true,
              },
            ],
          },
        ],
        group: [
          'Difficulty.id',
          'Difficulty.name',
          'Difficulty.type',
          'Difficulty.sortOrder',
          'Difficulty.color',
        ],
        order: [[fn('COUNT', col('levels.passes.id')), 'DESC']],
        limit: 5,
        subQuery: false,
      });

      // Level Submission Stats
      const levelSubmissionStats = await LevelSubmission.count({
        where: {status: 'pending'},
      });

      // Pass Submission Stats
      const [pendingPassSubmissions, totalPassSubmissions] = await Promise.all([
        PassSubmission.count({
          where: {status: 'pending'},
        }),
        PassSubmission.count(),
      ]);

      return res.json({
        overview: {
          totalLevels,
          totalPasses,
          totalPlayers,
          totalActivePlayers,
          passesLast30Days: recentPassStats,
        },
        difficulties: {
          all: difficultyStats.map(diff => ({
            ...diff.get(),
            levelCount: Number(diff.get('levelCount')),
            passCount: Number(diff.get('passCount')),
          })),
          byType: difficultyStats.reduce(
            (acc, diff) => {
              const type = diff.type;
              if (!acc[type]) {
                acc[type] = [];
              }
              acc[type].push({
                ...diff.get(),
                levelCount: Number(diff.get('levelCount')),
                passCount: Number(diff.get('passCount')),
              });
              return acc;
            },
            {} as Record<string, Array<any>>,
          ),
          top: topDifficulties.map(diff => ({
            ...diff.get(),
            passCount: Number(diff.get('passCount')),
          })),
        },
        submissions: {
          pendingLevels: levelSubmissionStats,
          passes: {
            pending: pendingPassSubmissions,
            total: totalPassSubmissions,
          },
        },
      });
    } catch (queryError) {
      logger.error('Query execution failed:', queryError);
      throw queryError;
    }
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

      // Top players by number of passes
      Player.findAll({
        attributes: [
          'name',
          'country',
          [fn('COUNT', col('passes.id')), 'passCount'],
        ],
        include: [
          {
            model: Pass,
            as: 'passes',
            attributes: [],
            where: {isDeleted: false},
          },
        ],
        group: ['Player.id'],
        order: [[literal('passCount'), 'DESC']],
        limit: 10,
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
