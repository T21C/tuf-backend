import {Request, Response, Router} from 'express';
import {Op, OrderItem, WhereOptions} from 'sequelize';
import {escapeRegExp} from '../../misc/Utility';
import Pass from '../../models/Pass';
import Level from '../../models/Level';
import Player from '../../models/Player';
import Judgement from '../../models/Judgement';
import {Auth} from '../../middleware/auth';
import {getIO} from '../../utils/socket';
import {calcAcc, IJudgements} from '../../misc/CalcAcc';
import {getScoreV2} from '../../misc/CalcScore';
import sequelize from '../../config/db';
import {IPass as PassInterface} from '../../interfaces/models';
import Difficulty from '../../models/Difficulty';
import {Cache} from '../../middleware/cache';
import { calculateRankedScore } from '../../misc/PlayerStatsCalculator';

const router: Router = Router();


type WhereClause = {
  isDeleted?: boolean;
  levelId?: number;
  is12K?: boolean;
  '$player.name$'?: {[Op.like]: string};
  '$level.diffId$'?:
    | {[Op.gte]: number}
    | {[Op.lte]: number}
    | {
        [Op.gte]?: number;
        [Op.lte]?: number;
      };
  [Op.or]?: Array<{
    '$player.name$'?: {[Op.like]: string};
    '$level.song$'?: {[Op.like]: string};
    '$level.artist$'?: {[Op.like]: string};
    '$level.difficulty.name$'?: {[Op.like]: string};
    levelId?: {[Op.like]: string};
    id?: {[Op.like]: string};
  }>;
} & WhereOptions<PassInterface>;

const difficultyNameToSortOrder: { [key: string]: number } = {
  'P1': 1, 'P2': 3, 'P3': 4, 'P4': 5, 'P5': 6,
  'P6': 7, 'P7': 8, 'P8': 9, 'P9': 10, 'P10': 11,
  'P11': 12, 'P12': 13, 'P13': 14, 'P14': 15, 'P15': 16,
  'P16': 17, 'P17': 18, 'P18': 18.5, 'P19': 19, 'P20': 19.5,
  'G1': 20, 'G2': 20.05, 'G3': 20.1, 'G4': 20.15, 'G5': 20.2,
  'G6': 20.25, 'G7': 20.3, 'G8': 20.35, 'G9': 20.4, 'G10': 20.45,
  'G11': 20.5, 'G12': 20.55, 'G13': 20.6, 'G14': 20.65, 'G15': 20.7,
  'G16': 20.75, 'G17': 20.8, 'G18': 20.85, 'G19': 20.9, 'G20': 20.95,
  'U1': 21, 'U2': 21.04, 'U3': 21.05, 'U4': 21.09, 'U5': 21.1,
  'U6': 21.14, 'U7': 21.15, 'U8': 21.19, 'U9': 21.2, 'U10': 21.24,
  'U11': 21.25, 'U12': 21.29, 'U13': 21.3, 'U14': 21.34, 'U15': 21.35,
  'U16': 21.39, 'U17': 21.4, 'U18': 21.44, 'U19': 21.45, 'U20': 21.49
};

// Helper function to build where clause
const buildWhereClause = (query: {
  deletedFilter?: string;
  minDiff?: string;
  maxDiff?: string;
  only12k?: string | boolean;
  levelId?: string;
  player?: string;
  query?: string;
}): WhereClause => {
  const where: WhereClause = {};

  // Handle deleted filter
  if (query.deletedFilter === 'hide') {
    where.isDeleted = false;
  } else if (query.deletedFilter === 'only') {
    where.isDeleted = true;
  }

  // Update difficulty range filter
  if (query.minDiff || query.maxDiff) {
    where['$level.diffId$'] = {};
    
    // Convert difficulty names to sortOrder values
    const minDiffValue = query.minDiff ? difficultyNameToSortOrder[query.minDiff] : undefined;
    const maxDiffValue = query.maxDiff ? difficultyNameToSortOrder[query.maxDiff] : undefined;

    if (minDiffValue !== undefined && maxDiffValue !== undefined) {
      if (minDiffValue > maxDiffValue) {
        // Swap if min > max
        where['$level.diffId$'] = {
          [Op.gte]: maxDiffValue,
          [Op.lte]: minDiffValue
        };
      } else {
        where['$level.diffId$'] = {
          [Op.gte]: minDiffValue,
          [Op.lte]: maxDiffValue
        };
      }
    } else if (minDiffValue !== undefined) {
      where['$level.diffId$'] = {
        [Op.gte]: minDiffValue
      };
    } else if (maxDiffValue !== undefined) {
      where['$level.diffId$'] = {
        [Op.lte]: maxDiffValue
      };
    }
  }

  // Add 12k filter
  if (query.only12k === 'true' || query.only12k === true) {
    where.is12K = true;
  } else {
    where.is12K = false;
  }

  // Level ID filter
  if (query.levelId) {
    where.levelId = Number(query.levelId);
  }

  // Player name filter
  if (query.player) {
    where['$player.name$'] = {[Op.like]: `%${escapeRegExp(query.player)}%`};
  }

  // General search
  if (query.query) {
    const searchTerm = escapeRegExp(query.query);
    where[Op.or] = [
      {'$player.name$': {[Op.like]: `%${searchTerm}%`}},
      {'$level.song$': {[Op.like]: `%${searchTerm}%`}},
      {'$level.artist$': {[Op.like]: `%${searchTerm}%`}},
      {'$level.difficulty.name$': {[Op.like]: `%${searchTerm}%`}},
      {levelId: {[Op.like]: `%${searchTerm}%`}},
      {id: {[Op.like]: `%${searchTerm}%`}},
    ];
  }

  return where;
};

// Get sort options
const getSortOptions = (sort?: string): OrderItem[] => {
  switch (sort) {
    case 'RECENT_ASC':
      return [['vidUploadTime', 'ASC']];
    case 'RECENT_DESC':
      return [['vidUploadTime', 'DESC']];
    case 'SCORE_ASC':
      return [
        ['scoreV2', 'ASC'],
        ['id', 'DESC'], // Secondary sort by newest first
      ];
    case 'SCORE_DESC':
      return [
        ['scoreV2', 'DESC'],
        ['id', 'DESC'], // Secondary sort by newest first
      ];
    case 'XACC_ASC':
      return [
        ['accuracy', 'ASC'],
        ['scoreV2', 'DESC'], // Secondary sort by highest score
        ['id', 'DESC'], // Tertiary sort by newest first
      ];
    case 'XACC_DESC':
      return [
        ['accuracy', 'DESC'],
        ['scoreV2', 'DESC'], // Secondary sort by highest score
        ['id', 'DESC'], // Tertiary sort by newest first
      ];
    case 'DIFF_ASC':
      return [
        [{model: Level, as: 'level'}, 'diffId', 'ASC'],
        ['scoreV2', 'DESC'], // Secondary sort by highest score
        ['id', 'DESC'], // Tertiary sort by newest first
      ];
    case 'DIFF_DESC':
      return [
        [{model: Level, as: 'level'}, 'diffId', 'DESC'],
        ['scoreV2', 'DESC'], // Secondary sort by highest score
        ['id', 'DESC'], // Tertiary sort by newest first
      ];
    case 'RANDOM':
      return [sequelize.random()];
    default:
      return [
        ['scoreV2', 'DESC'], // Default to highest score
        ['id', 'DESC'], // Secondary sort by newest first
      ];
  }
};

router.get('/level/:levelId', async (req: Request, res: Response) => {
  try {
    const {levelId} = req.params;

    const passes = await Pass.findAll({
      where: {
        levelId: parseInt(levelId),
        isDeleted: false,
        '$player.isBanned$': false,
      },
      include: [
        {
          model: Player,
          as: 'player',
          attributes: ['name', 'country', 'isBanned'],
        },
        {
          model: Judgement,
          as: 'judgements',
        },
      ],
    });

    return res.json(passes);
  } catch (error) {
    console.error('Error fetching passes:', error);
    return res.status(500).json({error: 'Failed to fetch passes'});
  }
});

router.get('/', async (req: Request, res: Response) => {
  try {
    const routeStart = performance.now();
    const where = buildWhereClause(req.query);
    const order = getSortOptions(req.query.sort as string);

    // First get all IDs in correct order
    const allIds = await Pass.findAll({
      where,
      include: [
        {
          model: Player,
          as: 'player',
          where: { isBanned: false },
          required: true,
        },
        {
          model: Level,
          as: 'level',
          include: [
            {
              model: Difficulty,
              as: 'difficulty',
              required: false,
            },
          ],
        },
      ],
      order,
      attributes: ['id'],
      raw: true,
    });

    // Then get paginated results using those IDs in their original order
    const offset = parseInt(req.query.offset as string) || 0;
    const limit = parseInt(req.query.limit as string) || 30;
    const paginatedIds = allIds
      .map((pass: any) => pass.id)
      .slice(offset, offset + limit);

    const results = await Pass.findAll({
      where: {
        ...where,
        id: {
          [Op.in]: paginatedIds,
        },
      },
      include: [
        {
          model: Player,
          as: 'player',
          attributes: ['name', 'country', 'isBanned'],
          where: { isBanned: false },
          required: true,
        },
        {
          model: Level,
          as: 'level',
          where: { isHidden: false },
          attributes: ['song', 'artist', 'baseScore'],
          include: [
            {
              model: Difficulty,
              as: 'difficulty',
            },
          ],
        },
        {
          model: Judgement,
          as: 'judgements',
        },
      ],
      order, // Maintain consistent ID ordering within paginated results
    });

    const totalTime = performance.now() - routeStart;
    console.log(`[PERF] Total route time: ${totalTime.toFixed(2)}ms`);

    return res.json({
      count: allIds.length,
      results,
    });
  } catch (error) {
    console.error('Error fetching passes:', error);
    return res.status(500).json({error: 'Failed to fetch passes'});
  }
});

router.get('/:id', Cache.leaderboard(), async (req: Request, res: Response) => {
  try {
    const pass = await Pass.findOne({
      where: {id: parseInt(req.params.id)},
      include: [
        {
          model: Player,
          as: 'player',
          include: [
            {
              model: Pass,
              as: 'passes',
              include: [
                {
                  model: Judgement,
                  as: 'judgements',
                },
                {
                  model: Level,
                  as: 'level',
                  include: [
                    {
                      model: Difficulty,
                      as: 'difficulty',
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          model: Level,
          as: 'level',
          include: [
            {
              model: Difficulty,
              as: 'difficulty',
            },
          ],
        },
        {
          model: Judgement,
          as: 'judgements',
        },
      ],
    });

    if (!pass) {
      return res.status(404).json({error: 'Pass not found'});
    }

    const leaderboardCache = req.leaderboardCache;
    if (!leaderboardCache) {
      throw new Error('LeaderboardCache not initialized');
    }

    // Calculate current and previous ranked scores
    const currentRankedScore = calculateRankedScore(pass.player?.passes?.map(pass => ({ 
      score: pass.scoreV2 || 0, 
      baseScore: pass.level?.baseScore || 0,
      xacc: pass.accuracy || 0,
      isWorldsFirst: pass.isWorldsFirst || false,
      is12K: pass.is12K || false,
      isDeleted: pass.isDeleted || false
    })) || []);

    const previousRankedScore = calculateRankedScore(pass.player?.passes?.filter(p => p.id !== pass.id).map(pass => ({ 
      score: pass.scoreV2 || 0, 
      baseScore: pass.level?.baseScore || 0,
      xacc: pass.accuracy || 0,
      isWorldsFirst: pass.isWorldsFirst || false,
      is12K: pass.is12K || false,
      isDeleted: pass.isDeleted || false
    })) || []);

    // Get player ranks
    const ranks = pass.player ? await leaderboardCache.getRanks(pass.player.id) : null;

    // Create response object without player passes
    const response = {
      ...pass.toJSON(),
      player: {
        id: pass.player?.id,
        name: pass.player?.name,
        country: pass.player?.country,
        isBanned: pass.player?.isBanned,
        discordId: pass.player?.discordId,
        discordUsername: pass.player?.discordUsername,
        discordAvatar: pass.player?.discordAvatar,
        discordAvatarId: pass.player?.discordAvatarId,
      },
      scoreInfo: {
        currentRankedScore,
        previousRankedScore,
        scoreDifference: currentRankedScore - previousRankedScore,
      },
      ranks,
    };

    return res.json(response);
  } catch (error) {
    console.error('Error fetching pass:', error);
    return res.status(500).json({error: 'Failed to fetch pass'});
  }
});

router.put(
  '/:id',
  Cache.leaderboard(),
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    const transaction = await sequelize.transaction();
    const leaderboardCache = req.leaderboardCache;
    if (!leaderboardCache) {
      throw new Error('LeaderboardCache not initialized');
    }
    try {
      const {id} = req.params;
      const originalPass = await Pass.findOne({
        where: {id: parseInt(id)},
        include: [
          {
            model: Level,
            as: 'level',
            include: [
              {
                model: Difficulty,
                as: 'difficulty',
              },
            ],
          },
          {
            model: Judgement,
            as: 'judgements',
          },
        ],
        transaction,
      });

      if (!originalPass) {
        await transaction.rollback();
        return res.status(404).json({error: 'Pass not found'});
      }

      // Handle level change and clear count updates
      if (originalPass.levelId !== req.body.levelId) {
        await Promise.all([
          Level.decrement('clears', {
            where: {id: originalPass.levelId},
            transaction,
          }),
          Level.increment('clears', {
            where: {id: req.body.levelId},
            transaction,
          }),
        ]);
      }

      // Get the correct level for score calculation
      const level =
        originalPass.levelId !== req.body.levelId
          ? await Level.findByPk(req.body.levelId, {transaction}).then(
              level => level?.dataValues,
            )
          : originalPass.level?.dataValues;

      if (!level) {
        await transaction.rollback();
        return res.status(404).json({error: 'Level not found'});
      }

      // Calculate new accuracy and score
      const judgements = req.body.judgements;
      const accuracy = calcAcc(judgements);
      const scoreV2 = getScoreV2(
        {
          speed: req.body.speed,
          judgements: judgements as IJudgements,
          isNoHoldTap: req.body.isNoHoldTap,
        },
        {
          baseScore: level.baseScore || level.difficulty?.baseScore || 0,
        },
      );

      // Update pass
      await Pass.update(
        {
          levelId: req.body.levelId,
          speed: req.body.speed,
          playerId: req.body.playerId,
          feelingRating: req.body.feelingRating,
          vidTitle: req.body.vidTitle,
          videoLink: req.body.videoLink,
          vidUploadTime: new Date(req.body.vidUploadTime),
          is12K: req.body.is12K,
          is16K: req.body.is16K,
          isNoHoldTap: req.body.isNoHoldTap,
          accuracy,
          scoreV2,
          isAnnounced: req.body.isAnnounced,
        },
        {
          where: {id: parseInt(id)},
          transaction,
        },
      );

      // Update judgements
      await Judgement.update(judgements, {
        where: {id: parseInt(id)},
        transaction,
      });

      // Fetch the updated pass
      const updatedPass = await Pass.findOne({
        where: {id: parseInt(id)},
        include: [
          {
            model: Level,
            as: 'level',
            include: [
              {
                model: Difficulty,
                as: 'difficulty',
              },
            ],
          },
          {
            model: Judgement,
            as: 'judgements',
          },
          {
            model: Player,
            as: 'player',
            attributes: ['id', 'name', 'country', 'isBanned'],
          },
        ],
        transaction,
      });

      await transaction.commit();

      // Force cache update
      await leaderboardCache.forceUpdate();
      const io = getIO();
      io.emit('leaderboardUpdated');

      return res.json({
        message: 'Pass updated successfully',
        pass: updatedPass,
      });
    } catch (error) {
      await transaction.rollback();
      console.error('Error updating pass:', error);
      return res.status(500).json({error: 'Failed to update pass'});
    }
  },
);

router.delete('/:id', Cache.leaderboard(), Auth.superAdmin(), async (req: Request, res: Response) => {
    const transaction = await sequelize.transaction();
    const leaderboardCache = req.leaderboardCache;
    if (!leaderboardCache) {
      throw new Error('LeaderboardCache not initialized');
    }

    try {
      const {id} = req.params;

      const pass = await Pass.findOne({
        where: {id: parseInt(id)},
        include: [
          {
            model: Level,
            as: 'level',
            include: [
              {
                model: Difficulty,
                as: 'difficulty',
              },
            ],
          },
          {
            model: Player,
            as: 'player',
            attributes: ['id', 'name', 'country', 'isBanned'],
          },
          {
            model: Judgement,
            as: 'judgements',
          },
        ],
        transaction,
      });

      if (!pass) {
        await transaction.rollback();
        return res.status(404).json({error: 'Pass not found'});
      }

      // Soft delete the pass
      await Pass.update(
        {isDeleted: true},
        {
          where: {id: parseInt(id)},
          transaction,
        },
      );

      // Update level clear count
      await Level.decrement('clears', {
        where: {id: pass.levelId},
        transaction,
      });

      // If this was the last clear, update isCleared status
      const remainingClears = await Pass.count({
        where: {
          levelId: pass.levelId,
          isDeleted: false,
        },
        transaction,
      });

      if (remainingClears === 0) {
        await Level.update(
          {isCleared: false},
          {
            where: {id: pass.levelId},
            transaction,
          },
        );
      }

      // Reload the pass to get updated data
      await pass.reload({
        include: [
          {
            model: Level,
            as: 'level',
            include: [
              {
                model: Difficulty,
                as: 'difficulty',
              },
            ],
          },
          {
            model: Player,
            as: 'player',
            attributes: ['id', 'name', 'country', 'isBanned'],
          },
          {
            model: Judgement,
            as: 'judgements',
          },
        ],
        transaction,
      });

      await transaction.commit();

      // Force cache update
      if (!leaderboardCache) {
        throw new Error('LeaderboardCache not initialized');
      }
      await leaderboardCache.forceUpdate();
      const io = getIO();
      io.emit('leaderboardUpdated');
      io.emit('passesUpdated');

      return res.json({
        message: 'Pass soft deleted successfully',
        pass: pass,
      });
    } catch (error) {
      await transaction.rollback();
      console.error('Error soft deleting pass:', error);
      return res.status(500).json({error: 'Failed to soft delete pass'});
    }
  },
);

// Add restore endpoint
router.patch('/:id/restore', Cache.leaderboard(), Auth.superAdmin(), async (req: Request, res: Response) => {
    const transaction = await sequelize.transaction();
    const leaderboardCache = req.leaderboardCache;
    if (!leaderboardCache) {
      throw new Error('LeaderboardCache not initialized');
    }
    try {
      const {id} = req.params;

      const pass = await Pass.findOne({
        where: {id: parseInt(id)},
        include: [
          {
            model: Level,
            as: 'level',
            include: [
              {
                model: Difficulty,
                as: 'difficulty',
              },
            ],
          },
        ],
        transaction,
      });

      if (!pass) {
        await transaction.rollback();
        return res.status(404).json({error: 'Pass not found'});
      }

      // Restore the pass
      await Pass.update(
        {isDeleted: false},
        {
          where: {id: parseInt(id)},
          transaction,
        },
      );

      // Update level clear count and status
      await Promise.all([
        Level.increment('clears', {
          where: {id: pass.levelId},
          transaction,
        }),
        Level.update(
          {isCleared: true},
          {
            where: {id: pass.levelId},
            transaction,
          },
        ),
      ]);

      await transaction.commit();

      // Force cache update
      if (!leaderboardCache) {
        throw new Error('LeaderboardCache not initialized');
      }
      await leaderboardCache.forceUpdate();
      const io = getIO();
      io.emit('leaderboardUpdated');
      io.emit('passesUpdated');

      return res.json({
        message: 'Pass restored successfully',
        pass: pass,
      });
    } catch (error) {
      await transaction.rollback();
      console.error('Error restoring pass:', error);
      return res.status(500).json({error: 'Failed to restore pass'});
    }
  },
);

// Add new route for getting pass by ID as a list
router.get('/byId/:id', async (req: Request, res: Response) => {
  try {
    const passId = parseInt(req.params.id);
    if (!passId || isNaN(passId) || passId <= 0) {
      return res.status(400).json({ error: 'Invalid pass ID' });
    }

    const pass = await Pass.findOne({
      where: {
        id: passId,
        isDeleted: false,
      },
      include: [
        {
          model: Player,
          as: 'player',
          attributes: ['name', 'country', 'isBanned'],
          where: { isBanned: false },
          required: true,
        },
        {
          model: Level,
          as: 'level',
          required: true,
          attributes: ['song', 'artist', 'baseScore'],
          include: [
            {
              model: Difficulty,
              as: 'difficulty',
              required: true,
            },
          ],
        },
        {
          model: Judgement,
          as: 'judgements',
          required: false,
        },
      ],
    });

    if (!pass) {
      return res.json({count: 0, results: []});
    }

    return res.json({count: 1, results: [pass]});
  } catch (error) {
    console.error('Error fetching pass by ID:', error);
    return res.status(500).json({error: 'Failed to fetch pass'});
  }
});

// Get unannounced passes
router.get('/unannounced/new', async (req: Request, res: Response) => {
  try {
    const passes = await Pass.findAll({
      where: {
        isAnnounced: false,
        isDeleted: false,
      },
      include: [
        {
          model: Player,
          as: 'player',
          attributes: ['name', 'country', 'isBanned'],
          where: { isBanned: false },
          required: true,
        },
        {
          model: Level,
          as: 'level',
          required: true,
          include: [
            {
              model: Difficulty,
              as: 'difficulty',
              required: true,
            },
          ],
        },
        {
          model: Judgement,
          as: 'judgements',
          required: false,
        },
      ],
      order: [['updatedAt', 'DESC']]
    });

    return res.json(passes);
  } catch (error) {
    console.error('Error fetching unannounced passes:', error);
    return res.status(500).json({ error: 'Failed to fetch unannounced passes' });
  }
});

// Mark passes as announced
router.post('/announce', async (req: Request, res: Response) => {
  try {
    const { passIds } = req.body;
    
    if (!Array.isArray(passIds) || !passIds.every(id => Number.isInteger(id) && id > 0)) {
      return res.status(400).json({ error: 'passIds must be an array of valid IDs' });
    }

    await Pass.update(
      { isAnnounced: true },
      {
        where: {
          id: {
            [Op.in]: passIds
          },
          isDeleted: false
        }
      }
    );

    return res.json({ success: true, message: 'Passes marked as announced' });
  } catch (error) {
    console.error('Error marking passes as announced:', error);
    return res.status(500).json({ error: 'Failed to mark passes as announced' });
  }
});

// Mark a single pass as announced
router.post('/markAnnounced/:id', async (req: Request, res: Response) => {
  try {
    const passId = parseInt(req.params.id);
    if (!passId || isNaN(passId) || passId <= 0) {
      return res.status(400).json({ error: 'Invalid pass ID' });
    }

    const pass = await Pass.findOne({
      where: {
        id: passId,
        isDeleted: false
      }
    });
    
    if (!pass) {
      return res.status(404).json({ error: 'Pass not found' });
    }

    await pass.update({ isAnnounced: true });
    return res.json({ success: true });
  } catch (error) {
    console.error('Error marking pass as announced:', error);
    return res.status(500).json({ 
      error: 'Failed to mark pass as announced',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

export default router;
