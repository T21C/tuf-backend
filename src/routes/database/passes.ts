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
import { sseManager } from '../../utils/sse';
import User from '../../models/User';
import { excludePlaceholder } from '../../middleware/excludePlaceholder';
import {PlayerStatsService} from '../../services/PlayerStatsService';

const router: Router = Router();
const playerStatsService = PlayerStatsService.getInstance();

export async function updateWorldsFirstStatus(levelId: number, transaction?: any) {
  // Find the earliest non-deleted pass for this level from non-banned players
  const earliestPass = await Pass.findOne({
    where: {
      levelId,
      isDeleted: false
    },
    include: [{
      model: Player,
      as: 'player',
      where: { isBanned: false },
      required: true
    }],
    order: [['vidUploadTime', 'ASC']],
    transaction
  });

  // Reset all passes for this level to not be world's first
  await Pass.update(
    { isWorldsFirst: false },
    { 
      where: { levelId },
      transaction
    }
  );

  // If we found an earliest pass, mark it as world's first
  if (earliestPass) {
    await Pass.update(
      { isWorldsFirst: true },
      { 
        where: { id: earliestPass.id },
        transaction
      }
    );
  }
}

type WhereClause = {
  isDeleted?: boolean;
  levelId?: number | { [Op.in]: number[] };
  is12K?: boolean;
  '$player.name$'?: {[Op.like]: string};
  '$level.diffId$'?: {[Op.in]: number[]};
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
const buildWhereClause = async (query: {
  deletedFilter?: string;
  minDiff?: string;
  maxDiff?: string;
  only12k?: string | boolean;
  levelId?: string;
  player?: string;
  query?: string;
}): Promise<WhereClause> => {
  const where: WhereClause = {};

  // Handle deleted filter
  if (query.deletedFilter === 'hide') {
    where.isDeleted = false;
  } else if (query.deletedFilter === 'only') {
    where.isDeleted = true;
  }

  // Update difficulty range filter
  if (query.minDiff || query.maxDiff) {
    // Find difficulties by name and get their sortOrder values
    const [minDiff, maxDiff] = await Promise.all([
      query.minDiff ? Difficulty.findOne({
        where: { name: query.minDiff, type: 'PGU' },
        attributes: ['id', 'sortOrder']
      }) : null,
      query.maxDiff ? Difficulty.findOne({
        where: { name: query.maxDiff, type: 'PGU' },
        attributes: ['id', 'sortOrder']
      }) : null
    ]);

    if (minDiff || maxDiff) {
      const pguDifficulties = await Difficulty.findAll({
        where: {
          type: 'PGU',
          sortOrder: {
            ...(minDiff && { [Op.gte]: minDiff.sortOrder }),
            ...(maxDiff && { [Op.lte]: maxDiff.sortOrder })
          }
        },
        attributes: ['id']
      });
      
      if (pguDifficulties.length > 0) {
        where['$level.difficulty.id$'] = pguDifficulties.map(d => d.id);
      }
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
          include: [
            {
              model: User,
              as: 'user',
              attributes: ['id', 'username', 'nickname', 'avatarUrl', 'isSuperAdmin', 'isRater'],
            },
          ],
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

router.post('/', async (req: Request, res: Response) => {
  try {
    const routeStart = performance.now();
    const {
      deletedFilter,
      minDiff,
      maxDiff,
      only12k,
      levelId,
      player,
      query: searchQuery,
      offset = 0,
      limit = 30,
      sort
    } = req.body;

    // Step 1: Get matching difficulty IDs if difficulty filter is applied
    let matchingLevelIds: number[] | undefined;
    if (minDiff || maxDiff) {
      const [minDiffObj, maxDiffObj] = await Promise.all([
        minDiff ? Difficulty.findOne({
          where: { name: minDiff, type: 'PGU' },
          attributes: ['id', 'sortOrder']
        }) : null,
        maxDiff ? Difficulty.findOne({
          where: { name: maxDiff, type: 'PGU' },
          attributes: ['id', 'sortOrder']
        }) : null
      ]);

      if (minDiffObj || maxDiffObj) {
        const pguDifficulties = await Difficulty.findAll({
          where: {
            type: 'PGU',
            sortOrder: {
              ...(minDiffObj && { [Op.gte]: minDiffObj.sortOrder }),
              ...(maxDiffObj && { [Op.lte]: maxDiffObj.sortOrder })
            }
          },
          attributes: ['id']
        });

        if (pguDifficulties.length > 0) {
          const levels = await Level.findAll({
            where: {
              diffId: {
                [Op.in]: pguDifficulties.map(d => d.id)
              }
            },
            attributes: ['id']
          });
          matchingLevelIds = levels.map(l => l.id);
        }
      }
    }

    // Build base where clause
    const where: WhereClause = {};

    // Handle deleted filter
    if (deletedFilter === 'hide') {
      where.isDeleted = false;
    } else if (deletedFilter === 'only') {
      where.isDeleted = true;
    }

    // Add 12k filter
    if (only12k === 'true' || only12k === true) {
      where.is12K = true;
    } else {
      where.is12K = false;
    }

    // Add level ID filter from difficulty matching
    if (matchingLevelIds) {
      where.levelId = {
        [Op.in]: matchingLevelIds
      };
    }

    // Add specific level ID filter if provided
    if (levelId) {
      where.levelId = Number(levelId);
    }

    // Add player name filter
    if (player) {
      where['$player.name$'] = {[Op.like]: `%${escapeRegExp(player)}%`};
    }

    // Add general search
    if (searchQuery) {
      const searchTerm = escapeRegExp(searchQuery);
      where[Op.or] = [
        {'$player.name$': {[Op.like]: `%${searchTerm}%`}},
        {'$level.song$': {[Op.like]: `%${searchTerm}%`}},
        {'$level.artist$': {[Op.like]: `%${searchTerm}%`}},
        {'$level.difficulty.name$': {[Op.like]: `%${searchTerm}%`}},
        {levelId: {[Op.like]: `%${searchTerm}%`}},
        {id: {[Op.like]: `%${searchTerm}%`}},
      ];
    }

    const order = getSortOptions(sort);
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
      order,
    });


    return res.json({
      count: allIds.length,
      results,
    });
  } catch (error) {
    console.error('Error fetching passes:', error);
    return res.status(500).json({error: 'Failed to fetch passes'});
  }
});

router.get('/:id', async (req: Request, res: Response) => {
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
            {
              model: User,
              as: 'user',
              attributes: ['id', 'username', 'nickname', 'avatarUrl', 'isSuperAdmin', 'isRater'],
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

    // Get player stats
    const playerStats = pass.player ? await playerStatsService.getPlayerStats(pass.player.id) : null;

    // Create response object without player passes
    const response = {
      ...pass.toJSON(),
      player: {
        id: pass.player?.id,
        name: pass.player?.name,
        country: pass.player?.country,
        isBanned: pass.player?.isBanned,
        user: pass.player?.user,
      },
      scoreInfo: {
        currentRankedScore,
        previousRankedScore,
        scoreDifference: currentRankedScore - previousRankedScore,
      },
      stats: playerStats,
    };

    return res.json(response);
  } catch (error) {
    console.error('Error fetching pass:', error);
    return res.status(500).json({
      error: 'Failed to fetch pass',
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

router.put('/:id', Auth.superAdmin(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  try {
    const {id} = req.params;
    const {judgements, isDeleted} = req.body;

    // Update pass
    const pass = await Pass.findOne({
      where: {id: parseInt(id)},
      include: [
        {
          model: Level,
          as: 'level',
        },
        {
          model: Player,
          as: 'player',
        },
      ],
      transaction,
    });

    if (!pass) {
      await transaction.rollback();
      return res.status(404).json({error: 'Pass not found'});
    }

    if (isDeleted !== undefined) {
      await pass.update({isDeleted}, {transaction});
    }

    // Update judgements
    if (judgements) {
      await Judgement.update(judgements, {
        where: {id: parseInt(id)},
        transaction,
      });
    }

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

    // Update player stats
    if (pass.player) {
      await playerStatsService.updatePlayerStats(pass.player.id);
    }

    const io = getIO();
    io.emit('leaderboardUpdated');

    // Get player's new stats
    if (updatedPass && updatedPass.player) {
      const playerStats = await playerStatsService.getPlayerStats(updatedPass.player.id);

      // Emit SSE event with pass update data
      sseManager.broadcast({
        type: 'passUpdate',
        data: {
          playerId: updatedPass.player.id,
          passedLevelId: updatedPass.levelId,
          newScore: playerStats?.rankedScore || 0,
          action: 'update',
        },
      });
    }

    return res.json(updatedPass);
  } catch (error) {
    await transaction.rollback();
    console.error('Error updating pass:', error);
    return res.status(500).json({
      error: 'Failed to update pass',
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

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

      // Store levelId before deleting
      const levelId = pass.levelId;

      // Soft delete the pass
      await Pass.update(
        { isDeleted: true },
        {
          where: { id: parseInt(id) },
          transaction,
        }
      );

      // Update world's first status for this level
      await updateWorldsFirstStatus(levelId, transaction);

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
      await leaderboardCache.forceUpdate();
      const io = getIO();
      io.emit('leaderboardUpdated');
      io.emit('passesUpdated');

      // Get player's new score from leaderboard cache
      if (pass && pass.player && pass.levelId) {
        const playerId = pass.player.id;
        const players = await leaderboardCache.get('rankedScore', 'desc', true);
        const playerData = players.find(p => p.id === playerId);

        // Emit SSE event with pass deletion data
        sseManager.broadcast({
          type: 'passUpdate',
          data: {
            playerId,
            passedLevelId: pass.levelId,
            newScore: playerData?.rankedScore || 0,
            action: 'delete'
          }
        });
      }

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

      // Store levelId
      const levelId = pass.levelId;

      // Restore the pass
      await Pass.update(
        { isDeleted: false },
        {
          where: { id: parseInt(id) },
          transaction,
        }
      );

      // Update world's first status for this level
      await updateWorldsFirstStatus(levelId, transaction);

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
      await leaderboardCache.forceUpdate();
      const io = getIO();
      io.emit('leaderboardUpdated');
      io.emit('passesUpdated');

      // Get player's new score from leaderboard cache
      if (pass && pass.player && pass.levelId) {
        const playerId = pass.player.id;
        const players = await leaderboardCache.get('rankedScore', 'desc', true);
        const playerData = players.find(p => p.id === playerId);

        // Emit SSE event with pass restoration data
        sseManager.broadcast({
          type: 'passUpdate',
          data: {
            playerId,
            passedLevelId: pass.levelId,
            newScore: playerData?.rankedScore || 0,
            action: 'restore'
          }
        });
      }

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
router.get('/byId/:id', excludePlaceholder.fromResponse(), async (req: Request, res: Response) => {
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

// Helper function to ensure string type
const ensureString = (value: any): string | undefined => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0]?.toString();
  if (value?.toString) return value.toString();
  return undefined;
};

// Main GET endpoint with search
router.get('/', excludePlaceholder.fromResponse(), async (req: Request, res: Response) => {
  try {
    const {
      deletedFilter,
      minDiff,
      maxDiff,
      only12k,
      levelId,
      player,
      query: searchQuery,
      offset = '0',
      limit = '30',
      sort
    } = req.query;

    // Step 1: Get matching difficulty IDs if difficulty filter is applied
    let matchingLevelIds: number[] | undefined;
    const minDiffStr = ensureString(minDiff);
    const maxDiffStr = ensureString(maxDiff);

    if (minDiffStr || maxDiffStr) {
      const [minDiffObj, maxDiffObj] = await Promise.all([
        minDiffStr ? Difficulty.findOne({
          where: { name: minDiffStr, type: 'PGU' },
          attributes: ['id', 'sortOrder']
        }) : null,
        maxDiffStr ? Difficulty.findOne({
          where: { name: maxDiffStr, type: 'PGU' },
          attributes: ['id', 'sortOrder']
        }) : null
      ]);

      if (minDiffObj || maxDiffObj) {
        const pguDifficulties = await Difficulty.findAll({
          where: {
            type: 'PGU',
            sortOrder: {
              ...(minDiffObj && { [Op.gte]: minDiffObj.sortOrder }),
              ...(maxDiffObj && { [Op.lte]: maxDiffObj.sortOrder })
            }
          },
          attributes: ['id']
        });

        if (pguDifficulties.length > 0) {
          const levels = await Level.findAll({
            where: {
              diffId: {
                [Op.in]: pguDifficulties.map(d => d.id)
              }
            },
            attributes: ['id']
          });
          matchingLevelIds = levels.map(l => l.id);
        }
      }
    }

    // Build base where clause
    const where: WhereClause = {};

    // Handle deleted filter
    const deletedFilterStr = ensureString(deletedFilter);
    if (deletedFilterStr === 'hide') {
      where.isDeleted = false;
    } else if (deletedFilterStr === 'only') {
      where.isDeleted = true;
    }

    // Add 12k filter
    const only12kStr = ensureString(only12k);
    where.is12K = only12kStr === 'true';

    // Add level ID filter from difficulty matching
    if (matchingLevelIds) {
      where.levelId = {
        [Op.in]: matchingLevelIds
      };
    }

    // Add specific level ID filter if provided
    const levelIdStr = ensureString(levelId);
    if (levelIdStr) {
      where.levelId = Number(levelIdStr);
    }

    // Add player name filter
    const playerStr = ensureString(player);
    if (playerStr) {
      where['$player.name$'] = {[Op.like]: `%${escapeRegExp(playerStr)}%`};
    }

    // Add general search
    const searchQueryStr = ensureString(searchQuery);
    if (searchQueryStr) {
      const searchTerm = escapeRegExp(searchQueryStr);
      where[Op.or] = [
        {'$player.name$': {[Op.like]: `%${searchTerm}%`}},
        {'$level.song$': {[Op.like]: `%${searchTerm}%`}},
        {'$level.artist$': {[Op.like]: `%${searchTerm}%`}},
        {'$level.difficulty.name$': {[Op.like]: `%${searchTerm}%`}},
        {levelId: {[Op.like]: `%${searchTerm}%`}},
        {id: {[Op.like]: `%${searchTerm}%`}},
      ];
    }

    const order = getSortOptions(ensureString(sort));
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
    const offsetNum = Math.max(0, Number(ensureString(offset)) || 0);
    const limitNum = Math.max(1, Math.min(100, Number(ensureString(limit)) || 30));
    const paginatedIds = allIds
      .map((pass: any) => pass.id)
      .slice(offsetNum, offsetNum + limitNum);

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
      order,
    });

    return res.json({
      count: allIds.length,
      results,
    });
  } catch (error) {
    console.error('Error fetching passes:', error);
    return res.status(500).json({error: 'Failed to fetch passes'});
  }
});

export default router;
