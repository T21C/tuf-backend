import {Router} from 'express';
import {Op, fn, col, literal, Sequelize} from 'sequelize';
import Level from '../../../models/levels/Level.js';
import Pass from '../../../models/passes/Pass.js';
import Player from '../../../models/players/Player.js';
import Difficulty from '../../../models/levels/Difficulty.js';
import LevelSubmission from '../../../models/submissions/LevelSubmission.js';
import {PassSubmission} from '../../../models/submissions/PassSubmission.js';
import { logger } from '../../../server/services/LoggerService.js';

const router: Router = Router();

// Get overall statistics
router.get('/', async (req, res) => {
  try {
    try {
      const totalLevels = await Level.count({
        where: {isDeleted: false, isHidden: false},
      });

      const totalPasses = await Pass.count({
        where: {isDeleted: false},
      });

      const totalPlayers = await Player.count();

      const totalActivePlayers = await Player.count({
        include: [
          {
            model: Pass,
            as: 'passes',
            required: true,
            where: {isDeleted: false},
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
});

// Get player statistics
router.get('/players', async (req, res) => {
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
});

export default router;
