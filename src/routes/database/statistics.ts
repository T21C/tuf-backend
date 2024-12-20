import { Router } from 'express';
import { Op, fn, col, literal } from 'sequelize';
import Level from '../../models/Level';
import Pass from '../../models/Pass';
import Player from '../../models/Player';
import Difficulty from '../../models/Difficulty';
import { Cache } from '../../middleware/cache';
import LevelSubmission from '../../models/LevelSubmission';
import { PassSubmission } from '../../models/PassSubmission';
import Rating from '../../models/Rating';

const router: Router = Router();

// Get overall statistics
router.get('/', Cache.leaderboard(), async (req, res) => {
  try {
    console.log('Starting statistics fetch...');

    try {
      const totalLevels = await Level.count({
        where: { isDeleted: false }
      });
      console.log('1. Total levels query successful:', totalLevels);

      const totalPasses = await Pass.count({
        where: { isDeleted: false }
      });
      console.log('2. Total passes query successful:', totalPasses);

      const totalPlayers = await Player.count();
      console.log('3. Total players query successful:', totalPlayers);

      const totalActivePlayers = await Player.count({
        include: [{
          model: Pass,
          as: 'passes',
          required: true,
          where: { isDeleted: false }
        }]
      });
      console.log('4. Active players query successful:', totalActivePlayers);

      const difficultyStats = await Difficulty.findAll({
        attributes: {
          include: [
            [fn('COUNT', col('levels.id')), 'levelCount'],
            [fn('COUNT', col('levels->passes.id')), 'passCount']
          ]
        },
        include: [{
          model: Level,
          as: 'levels',
          attributes: [],
          where: { isDeleted: false },
          required: false,
          include: [{
            model: Pass,
            as: 'passes',
            attributes: [],
            where: { isDeleted: false },
            required: false
          }]
        }],
        group: [
          'Difficulty.id',
          'Difficulty.name',
          'Difficulty.type',
          'Difficulty.icon',
          'Difficulty.emoji',
          'Difficulty.color',
          'Difficulty.baseScore',
          'Difficulty.sortOrder',
          'Difficulty.legacy',
          'Difficulty.legacyIcon',
          'Difficulty.legacyEmoji',
          'Difficulty.createdAt',
          'Difficulty.updatedAt'
        ],
        order: [
          ['type', 'ASC'],
          ['sortOrder', 'ASC']
        ]
      });
      console.log('5. Difficulty stats query successful:', difficultyStats.length, 'records');

      const recentPassStats = await Pass.count({
        where: {
          isDeleted: false,
          vidUploadTime: {
            [Op.gte]: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
          }
        }
      });
      console.log('6. Recent pass stats query successful:', recentPassStats);

      const topDifficulties = await Difficulty.findAll({
        attributes: [
          'id',
          'name',
          'type',
          'sortOrder',
          'color',
          [fn('COUNT', col('levels.passes.id')), 'passCount']
        ],
        include: [{
          model: Level,
          as: 'levels',
          attributes: [],
          required: true,
          include: [{
            model: Pass,
            as: 'passes',
            attributes: [],
            where: { isDeleted: false },
            required: true
          }]
        }],
        group: ['Difficulty.id', 'Difficulty.name', 'Difficulty.type'],
        order: [[fn('COUNT', col('levels.passes.id')), 'DESC']],
        limit: 5,
        subQuery: false,
        logging: console.log
      });
      console.log('7. Top difficulties query successful:', topDifficulties.length, 'records');

      // Level Submission Stats
      const levelSubmissionStats = await LevelSubmission.count({
        where: { status: 'pending' }
      });
      console.log('8. Pending level submissions count:', levelSubmissionStats);

      // Pass Submission Stats
      const [pendingPassSubmissions, totalPassSubmissions] = await Promise.all([
        PassSubmission.count({
          where: { status: 'pending' }
        }),
        PassSubmission.count()
      ]);
      console.log('9. Pass submissions stats:', { pending: pendingPassSubmissions, total: totalPassSubmissions });

      // Rating Stats
      const ratingStats = await Rating.findAll({
        attributes: [
          [fn('AVG', col('average')), 'averageRating'],
          [fn('COUNT', col('id')), 'totalRatings'],
          [fn('SUM', literal('CASE WHEN lowDiff = true THEN 1 ELSE 0 END')), 'lowDiffCount']
        ]
      });
      console.log('10. Rating stats:', ratingStats[0]?.get());

      return res.json({
        overview: {
          totalLevels,
          totalPasses,
          totalPlayers,
          totalActivePlayers,
          passesLast30Days: recentPassStats
        },
        difficulties: {
          all: difficultyStats.map(diff => ({
            ...diff.get(),
            levelCount: Number(diff.get('levelCount')),
            passCount: Number(diff.get('passCount'))
          })),
          byType: difficultyStats.reduce((acc, diff) => {
            const type = diff.type;
            if (!acc[type]) {
              acc[type] = [];
            }
            acc[type].push({
              ...diff.get(),
              levelCount: Number(diff.get('levelCount')),
              passCount: Number(diff.get('passCount'))
            });
            return acc;
          }, {} as Record<string, Array<any>>),
          top: topDifficulties.map(diff => ({
            ...diff.get(),
            passCount: Number(diff.get('passCount'))
          }))
        },
        submissions: {
          pendingLevels: levelSubmissionStats,
          passes: {
            pending: pendingPassSubmissions,
            total: totalPassSubmissions
          }
        },
        ratings: {
          averageRating: Number(ratingStats[0]?.get('averageRating') || 0),
          totalRatings: Number(ratingStats[0]?.get('totalRatings') || 0),
          lowDiffCount: Number(ratingStats[0]?.get('lowDiffCount') || 0)
        }
      });

    } catch (queryError) {
      console.error('Query execution failed:', queryError);
      throw queryError;
    }

  } catch (error) {
    console.error('Error fetching statistics:', error);
    return res.status(500).json({
      error: 'Failed to fetch statistics',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

// Get player statistics
router.get('/players', async (req, res) => {
  try {
    const [playerCountByCountry, topPlayersByPasses] = await Promise.all([
      // Players by country
      Player.findAll({
        attributes: [
          'country',
          [fn('COUNT', col('id')), 'playerCount']
        ],
        group: ['country'],
        order: [[literal('playerCount'), 'DESC']]
      }),

      // Top players by number of passes
      Player.findAll({
        attributes: [
          'name',
          'country',
          [fn('COUNT', literal('passes.id')), 'passCount']
        ],
        include: [{
          model: Pass,
          as: 'passes',
          attributes: [],
          where: { isDeleted: false }
        }],
        group: ['Player.id'],
        order: [[literal('passCount'), 'DESC']],
        limit: 10
      })
    ]);

    return res.json({
      countryStats: playerCountByCountry.map(stat => ({
        country: stat.country,
        playerCount: Number(stat.get('playerCount'))
      })),
      topPassers: topPlayersByPasses.map(player => ({
        name: player.name,
        country: player.country,
        passCount: Number(player.get('passCount'))
      }))
    });
  } catch (error) {
    console.error('Error fetching player statistics:', error);
    return res.status(500).json({
      error: 'Failed to fetch player statistics',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

export default router; 