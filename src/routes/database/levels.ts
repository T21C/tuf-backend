import {Request, Response, Router} from 'express';
import {Op, Order, OrderItem, Sequelize, fn, literal, col} from 'sequelize';
import Level from '../../models/Level';
import Pass from '../../models/Pass';
import Rating from '../../models/Rating';
import Player from '../../models/Player';
import Judgement from '../../models/Judgement';
import {Auth} from '../../middleware/auth';
import {getIO} from '../../utils/socket';
import sequelize from '../../config/db';
import RatingDetail from '../../models/RatingDetail';
import Difficulty from '../../models/Difficulty';
import {Cache} from '../../middleware/cache';
import { sseManager } from '../../utils/sse';
import { getScoreV2 } from '../../misc/CalcScore';
import { calcAcc } from '../../misc/CalcAcc';

const router: Router = Router();

// Helper function to build where clause
const buildWhereClause = async (query: any) => {
  const where: any = {};
  const conditions: any[] = [];

  // Handle deleted filter
  if (query.deletedFilter === 'hide') {
    conditions.push({
      [Op.and]: [
        {isDeleted: false},
        {isHidden: false}
      ]
    });
  } else if (query.deletedFilter === 'only') {
    conditions.push({
      [Op.or]: [
        {isDeleted: true},
        {isHidden: true}
      ]
    });
  }

  // Handle cleared filter
  if (query.clearedFilter && query.clearedFilter === 'hide') {
    conditions.push({
      clears: 0
    });
  } else if (query.clearedFilter && query.clearedFilter === 'only') {
    conditions.push({
      clears: {
        [Op.gt]: 0
      }
    });
  }

  // Handle text search
  if (query.query) {
    const searchTerm = `%${query.query}%`;
    conditions.push({
      [Op.or]: [
        {song: {[Op.like]: searchTerm}},
        {artist: {[Op.like]: searchTerm}},
        {charter: {[Op.like]: searchTerm}},
      ],
    });
  }

  // Handle difficulty range filter
  if (query.minDiff || query.maxDiff) {
    // Find difficulties by name and get their sortOrder values
    const [minDiff, maxDiff] = await Promise.all([
      query.minDiff
        ? Difficulty.findOne({
            where: {name: query.minDiff},
            attributes: ['sortOrder', 'name', 'type'],
          })
        : null,
      query.maxDiff
        ? Difficulty.findOne({
            where: {name: query.maxDiff},
            attributes: ['sortOrder', 'name', 'type'],
          })
        : null,
    ]);

    // Get all special difficulties if they're selected
    const specialDiffs = query.specialDiffs ? query.specialDiffs.split(',') : [];
    const specialDiffIds = specialDiffs.length > 0 
      ? (await Difficulty.findAll({
          where: {
            name: {[Op.in]: specialDiffs},
            type: 'SPECIAL'
          },
          attributes: ['id']
        })).map(d => d.id)
      : [];

    // Build the difficulty condition
    if (minDiff && maxDiff && minDiff.type === 'PGU' && maxDiff.type === 'PGU') {
      // Handle PGU range
      const difficultyIds = await Difficulty.findAll({
        where: {
          [Op.or]: [
            // PGU range
            {
              type: 'PGU',
              sortOrder: {
                [Op.gte]: Math.min(minDiff.sortOrder, maxDiff.sortOrder),
                [Op.lte]: Math.max(minDiff.sortOrder, maxDiff.sortOrder)
              }
            },
            // Special difficulties if any
            ...(specialDiffIds.length > 0 ? [{id: {[Op.in]: specialDiffIds}}] : [])
          ]
        },
        attributes: ['id']
      });

      conditions.push({
        diffId: {
          [Op.in]: difficultyIds.map(d => d.id)
        }
      });
    } else if (specialDiffIds.length > 0) {
      // Only special difficulties selected
      conditions.push({
        diffId: {
          [Op.in]: specialDiffIds
        }
      });
    }
  }

  // Handle hide filters
  if (query.hideUnranked === 'true') {
    conditions.push({
      diffId: {[Op.ne]: 0},
    });
  }

  if (query.hideCensored === 'true' || query.hideEpic === 'true') {
    const difficultyNames = [];
    if (query.hideCensored === 'true') difficultyNames.push('-2');
    if (query.hideEpic === 'true') difficultyNames.push('0.9');

    const diffIds = await Difficulty.findAll({
      where: {
        name: {[Op.in]: difficultyNames},
      },
      attributes: ['id'],
    });

    conditions.push({
      diffId: {[Op.notIn]: diffIds.map(d => d.id)},
    });
  }

  conditions.push({
    [Op.and]: [
      {song: {[Op.ne]: 'Placeholder'}},
      {artist: {[Op.ne]: 'Placeholder'}},
      {charter: {[Op.ne]: 'Placeholder'}},
      {creator: {[Op.ne]: 'Placeholder'}},
      {publicComments: {[Op.ne]: 'Placeholder'}},
    ]
  });



  // Combine all conditions
  if (conditions.length > 0) {
    where[Op.and] = conditions;
  }

  return where;
};
// Update the type definition
type OrderOption = OrderItem | OrderItem[];

// Get sort options
const getSortOptions = (sort?: string): Order => {
  switch (sort) {
    case 'RECENT_DESC':
      return [['id', 'DESC']];
    case 'RECENT_ASC':
      return [['id', 'ASC']];
    case 'DIFF_ASC':
      return [
        [{model: Difficulty, as: 'difficulty'}, 'sortOrder', 'ASC'],
        ['id', 'DESC'],
      ];
    case 'DIFF_DESC':
      return [
        [{model: Difficulty, as: 'difficulty'}, 'sortOrder', 'DESC'],
        ['id', 'DESC'],
      ];
    case 'CLEARS_ASC':
      return [
        ['clears', 'ASC'],
        ['id', 'DESC'],
      ];
    case 'CLEARS_DESC':
      return [
        ['clears', 'DESC'],
        ['id', 'DESC'],
      ];
    case 'RANDOM':
      return [[literal('RAND()'), 'ASC']];
    default:
      return [['id', 'DESC']]; // Default to recent descending
  }
};

// Get all levels with filtering and pagination
router.get('/', async (req: Request, res: Response) => {
  try {
    const where = await buildWhereClause(req.query);
    const sort = req.query.sort as string;
    const isRandomSort = sort === 'RANDOM';
    const order = getSortOptions(sort);

    // For random sorting, we'll use a different approach to ensure consistent pagination
    if (isRandomSort) {
      // First, get all matching IDs
      const allIds = await Level.findAll({
        where,
        attributes: ['id'],
        raw: true,
      });

      // Generate a random seed based on the current hour to maintain consistency for a period
      const now = new Date();
      let seedValue = now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate() + now.getHours();
      
      // Use the seed to shuffle the array consistently
      const shuffledIds = allIds
        .map(level => level.id)
        .sort(() => {
          const x = Math.sin(seedValue++) * 10000;
          return x - Math.floor(x);
        });

      // Get the paginated slice of IDs
      const offset = parseInt(req.query.offset as string) || 0;
      const limit = parseInt(req.query.limit as string) || 30;
      const paginatedIds = shuffledIds.slice(offset, offset + limit);

      // Fetch the actual levels
      const results = await Level.findAll({
        where: {
          id: {
            [Op.in]: paginatedIds,
          },
        },
        include: [
          {
            model: Difficulty,
            as: 'difficulty',
            required: false,
          },
          {
            model: Pass,
            as: 'passes',
            required: false,
            attributes: ['id'],
          },
        ],
        // Use FIELD function to maintain the shuffled order
        order: [[literal(`FIELD(id, ${paginatedIds.join(',')})`), 'ASC']] as OrderItem[],
      });

      return res.json({
        count: allIds.length,
        results,
      });
    }

    const allIds = await Level.findAll({
      where,
      include: [
        {
          model: Difficulty,
          as: 'difficulty',
          required: false,
        },
      ],
      order,
      attributes: ['id'],
      raw: true,
    });

    const offset = parseInt(req.query.offset as string) || 0;
    const limit = parseInt(req.query.limit as string) || 30;
    const paginatedIds = allIds
      .map(level => level.id)
      .slice(offset, offset + limit);

    const results = await Level.findAll({
      where: {
        ...where,
        id: {
          [Op.in]: paginatedIds,
        },
      },
      include: [
        {
          model: Difficulty,
          as: 'difficulty',
          required: false,
        },
        {
          model: Pass,
          as: 'passes',
          required: false,
          attributes: ['id'],
        },
      ],
      order // Maintain consistent ID ordering within the paginated results
    });

    return res.json({
      count: allIds.length,
      results,
    });
  } catch (error) {
    console.error('Error fetching levels:', error);
    return res.status(500).json({error: 'Failed to fetch levels'});
  }
});

router.get('/byId/:id', async (req: Request, res: Response) => {
  if (isNaN(parseInt(req.params.id))) {
    return res.status(400).json({error: 'Invalid level ID'});
  }
  const level = await Level.findOne({
    where: {id: parseInt(req.params.id)},
    
    include: [
      {
        model: Difficulty,
        as: 'difficulty',
        required: false,
      },
      {
        model: Pass,
        as: 'passes',
        required: false,
        attributes: ['id'],
      },
    ],
  });
  return res.json(level);
});

// Get a single level by ID
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const level = await Level.findOne({
      where: {id: parseInt(req.params.id)},
      include: [
        {
          model: Pass,
          as: 'passes',
          include: [
            {
              model: Player,
              as: 'player',
            },
            {
              model: Judgement,
              as: 'judgements',
            },
          ],
        },
        {
          model: Difficulty,
          as: 'difficulty',
        },
      ],
    });

    if (!level) {
      return res.status(404).json({error: 'Level not found'});
    }

    return res.json(level);
  } catch (error) {
    console.error('Error fetching level:', error);
    return res.status(500).json({error: 'Failed to fetch level'});
  }
});

// Update a level
router.put('/:id', Auth.superAdmin(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();

  try {
    const {id} = req.params;
    const levelId = parseInt(id);

    if (isNaN(levelId)) {
      await transaction.rollback();
      return res.status(400).json({error: 'Invalid level ID'});
    }

    const level = await Level.findOne({
      where: {id: levelId},
      transaction,
      include: [
        {
          model: Difficulty,
          as: 'difficulty',
        }
      ]
    });

    if (!level) {
      await transaction.rollback();
      return res.status(404).json({error: 'Level not found'});
    }

    // Calculate new pguDiffNum if diffId is being updated
    let baseScore = req.body.baseScore; // Use the provided baseScore or keep it null

    if (req.body.diffId && req.body.diffId !== level.diffId) {
      if (baseScore === undefined) {
        const difficulty = await Difficulty.findByPk(req.body.diffId);
        baseScore = difficulty?.baseScore || null;
      }
    }

    // Handle rating creation/deletion if toRate is changing
    if (
      typeof req.body.toRate === 'boolean' &&
      req.body.toRate !== level.toRate
    ) {
      if (req.body.toRate) {
        // Create new rating if toRate is being set to true
        const existingRating = await Rating.findOne({
          where: {levelId: levelId},
          transaction,
        });

        if (!existingRating) {
          // Check if rerateNum starts with 'p' or 'P' followed by a number
          const lowDiff = req.body.rerateNum ? /^[pP]\d/.test(req.body.rerateNum) : false;

          await Rating.create(
            {
              levelId: levelId,
              currentDifficultyId: 0,
              lowDiff: lowDiff,
              requesterFR: '',
              averageDifficultyId: null,
            },
            {transaction},
          );
        }
      } else {
        // Delete rating if toRate is being set to false
        const existingRating = await Rating.findOne({
          where: {levelId: levelId},
          transaction,
        });

        if (existingRating) {
          // Delete rating details first
          await RatingDetail.destroy({
            where: {ratingId: existingRating.id},
            transaction,
          });
          // Then delete the rating
          await existingRating.destroy({transaction});
        }
      }
    }

    const existingRating = await Rating.findOne({
      where: {levelId: levelId},
      transaction,
    });

    if (existingRating) {
      const lowDiff = /^[pP]\d/.test(req.body.rerateNum) || /^[pP]\d/.test(existingRating.dataValues.requesterFR);
      await existingRating.update({ lowDiff }, { transaction });
    }
    
    let previousDiffId = level.previousDiffId;
    if (req.body.diffId && req.body.diffId !== level.diffId) {
      previousDiffId = level.diffId;
    }
    let isAnnounced = level.isAnnounced || req.body.toRate;
    if (isAnnounced && level.toRate && !req.body.toRate) {
      isAnnounced = false;
    }

    const difficulty = await Difficulty.findByPk(req.body.diffId);
    // Prepare update data with proper null handling
    const updateData = {
      song: req.body.song || undefined,
      artist: req.body.artist || undefined,
      creator: req.body.creator || undefined,
      charter: req.body.charter || undefined,
      vfxer: req.body.vfxer || undefined,
      team: req.body.team || undefined,
      diffId: req.body.diffId || undefined,
      // Explicitly handle baseScore to allow null values
      baseScore: baseScore === '' ? null : baseScore,
      videoLink: req.body.videoLink || undefined,
      dlLink: req.body.dlLink || undefined,
      workshopLink: req.body.workshopLink || undefined,
      publicComments: req.body.publicComments || undefined,
      toRate:
        typeof req.body.toRate === 'boolean' ? req.body.toRate : level.toRate,
      rerateReason: req.body.rerateReason || undefined,
      rerateNum: req.body.rerateNum || undefined,
      isAnnounced: req.body.isAnnounced !== undefined ? req.body.isAnnounced : isAnnounced,
      previousDiffId: 
      (req.body.previousDiffId !== undefined 
        && req.body.previousDiffId !== null) 
        ? req.body.previousDiffId 
        : previousDiffId,
    };

    // Update level
    await Level.update(updateData, {
      where: {id: levelId},
      transaction,
    });

    // If baseScore or diffId changed, recalculate all passes for this level
    if (req.body.baseScore !== undefined || req.body.diffId !== undefined) {
      const passes = await Pass.findAll({
        where: { 
          levelId,
        },
        include: [
          {
            model: Judgement,
            as: 'judgements'
          }
        ],
        transaction
      });

      // Recalculate and update each pass
      for (const passData of passes) {
        const pass = passData.dataValues;
        if (!pass.judgements) {
          continue;
        }
        const accuracy = calcAcc(pass.judgements);
        const scoreV2 = getScoreV2(
          {
            speed: pass.speed || 1,
            judgements: pass.judgements,
            isNoHoldTap: pass.isNoHoldTap || false,
          },
          {
            baseScore: updateData.baseScore ||
            difficulty?.baseScore ||
            level.difficulty?.baseScore || 0,
          }
        );
        await Pass.update(
          { 
            accuracy,
            scoreV2 
          },
          {
            where: { id: pass.id },
            transaction
          }
        );
      }
    }

    // Fetch the updated record with associations
    const updatedLevel = await Level.findOne({
      where: {id: levelId},
      include: [
        {
          model: Difficulty,
          as: 'difficulty',
          required: false,
        },
        {
          model: Pass,
          as: 'passes',
          required: false,
          attributes: ['id'],
        },
      ],
      transaction,
    });

    await transaction.commit();

    // Force cache update since level data affects pass calculations
    if (!req.leaderboardCache) {
      throw new Error('LeaderboardCache not initialized');
    }
    await req.leaderboardCache.forceUpdate();
    
    // Broadcast updates
    sseManager.broadcast({ type: 'ratingUpdate' });
    sseManager.broadcast({ type: 'levelUpdate' });
    sseManager.broadcast({ 
      type: 'passUpdate',
      data: {
        levelId,
        action: 'levelUpdate'
      }
    });

    return res.json({
      message: 'Level updated successfully',
      level: updatedLevel,
    });
  } catch (error) {
    await transaction.rollback();
    console.error('Error updating level:', error);
    return res.status(500).json({error: 'Failed to update level'});
  }
});

// Toggle rating status for a level
router.put('/:id/toRate', async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();

  try {
    const levelId = parseInt(req.params.id);
    if (isNaN(levelId)) {
      await transaction.rollback();
      return res.status(400).json({error: 'Invalid level ID'});
    }

    // Get the level
    const level = await Level.findByPk(levelId, {transaction});
    if (!level) {
      await transaction.rollback();
      return res.status(404).json({error: 'Level not found'});
    }

    // Check if rating exists
    const existingRating = await Rating.findOne({
      where: {levelId},
      transaction,
    });

    if (existingRating) {
      // If rating exists, delete all associated details first
      await RatingDetail.destroy({
        where: {ratingId: existingRating.id},
        transaction,
      });

      // Then delete the rating and update level
      await existingRating.destroy({transaction});
      await Level.update(
        {toRate: false},
        {
          where: {id: levelId},
          transaction,
        },
      );

      await transaction.commit();
      
      // Broadcast updates
      sseManager.broadcast({ type: 'ratingUpdate' });
      sseManager.broadcast({ type: 'levelUpdate' });
      
      return res.json({
        message: 'Rating removed successfully',
        toRate: false,
      });
    } else {
      // Create new rating with default values
      const newRating = await Rating.create(
        {
          levelId,
          currentDifficultyId: 0,
          lowDiff: false,
          requesterFR: '',
          averageDifficultyId: null,
        },
        {transaction},
      );

      // Update level to mark for rating
      await Level.update(
        {toRate: true},
        {
          where: {id: levelId},
          transaction,
        },
      );

      await transaction.commit();
      
      // Broadcast updates
      sseManager.broadcast({ type: 'ratingUpdate' });
      sseManager.broadcast({ type: 'levelUpdate' });
      
      return res.json({
        message: 'Rating created successfully',
        toRate: true,
        ratingId: newRating.id,
      });
    }
  } catch (error) {
    await transaction.rollback();
    console.error('Error toggling rating status:', error);
    return res.status(500).json({
      error: 'Failed to toggle rating status',
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

router.delete(
  '/:id',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    const transaction = await sequelize.transaction();

    try {
      const {id} = req.params;

      const level = await Level.findOne({
        where: {id: parseInt(id)},
        include: [
          {
            model: Difficulty,
            as: 'difficulty',
          },
          {
            model: Pass,
            as: 'passes',
            required: false,
            attributes: ['id'],
          },
        ],
        transaction,
      });

      if (!level) {
        await transaction.rollback();
        return res.status(404).json({error: 'Level not found'});
      }

      // Soft delete the level
      await Level.update(
        {isDeleted: true},
        {
          where: {id: parseInt(id)},
          transaction,
        },
      );

      // Reload the level to get updated data
      await level.reload({
        include: [
          {
            model: Difficulty,
            as: 'difficulty',
          },
          {
            model: Pass,
            as: 'passes',
            required: false,
            attributes: ['id'],
          },
        ],
        transaction,
      });

      await transaction.commit();

      // Force cache update since level deletion affects pass calculations
      if (!req.leaderboardCache) {
        throw new Error('LeaderboardCache not initialized');
      }
      await req.leaderboardCache.forceUpdate();
      const io = getIO();
      io.emit('leaderboardUpdated');
      io.emit('ratingsUpdated');

      // Broadcast updates
      sseManager.broadcast({ type: 'levelUpdate' });
      sseManager.broadcast({ type: 'ratingUpdate' });

      return res.json({
        message: 'Level soft deleted successfully',
        level: level,
      });
    } catch (error) {
      await transaction.rollback();
      console.error('Error soft deleting level:', error);
      return res.status(500).json({error: 'Failed to soft delete level'});
    }
  },
);

router.patch(
  '/:id/restore',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    const transaction = await sequelize.transaction();

    try {
      const {id} = req.params;

      const level = await Level.findOne({
        where: {id: parseInt(id)},
        transaction,
      });

      if (!level) {
        await transaction.rollback();
        return res.status(404).json({error: 'Level not found'});
      }

      // Restore both isDeleted and isHidden flags
      await Level.update(
        {
          isDeleted: false,
          isHidden: false
        },
        {
          where: {id: parseInt(id)},
          transaction,
        },
      );

      // Reload the level to get updated data
      await level.reload({
        include: [
          {
            model: Difficulty,
            as: 'difficulty',
          },
          {
            model: Pass,
            as: 'passes',
            required: false,
            attributes: ['id'],
          },
        ],
        transaction,
      });

      await transaction.commit();

      // Force cache update since level restoration affects pass calculations
      if (!req.leaderboardCache) {
        throw new Error('LeaderboardCache not initialized');
      }
      await req.leaderboardCache.forceUpdate();

      // Broadcast updates
      sseManager.broadcast({ type: 'levelUpdate' });
      sseManager.broadcast({ type: 'ratingUpdate' });

      return res.json({
        message: 'Level restored successfully',
        level: level,
      });
    } catch (error) {
      await transaction.rollback();
      console.error('Error restoring level:', error);
      return res.status(500).json({error: 'Failed to restore level'});
    }
  },
);

// Get unannounced new levels
router.get('/unannounced/new', async (req: Request, res: Response) => {
  try {
    const levels = await Level.findAll({
      where: {
        isAnnounced: false,
        diffId: {
          [Op.ne]: 0
        },
        previousDiffId: {
          [Op.or]: [
            { [Op.eq]: null },
            { [Op.eq]: 0 }
          ]
        },
        isDeleted: false
      },
      include: [
        {
          model: Difficulty,
          as: 'difficulty',
        }
      ],
      order: [['createdAt', 'DESC']]
    });

    return res.json(levels);
  } catch (error) {
    console.error('Error fetching unannounced new levels:', error);
    return res.status(500).json({ error: 'Failed to fetch unannounced new levels' });
  }
});

// Get unannounced rerates
router.get('/unannounced/rerates', async (req: Request, res: Response) => {
  try {
    const levels = await Level.findAll({
      where: {
        isAnnounced: false,
        diffId: {
          [Op.ne]: 0
        },
        previousDiffId: {
          [Op.and]: [
            { [Op.not]: null },
            { [Op.ne]: 0 }
          ]
        },
        isDeleted: false
      },
      include: [
        {
          model: Difficulty,
          as: 'difficulty',
        },
        {
          model: Difficulty,
          as: 'previousDifficulty',
        }
      ],
      order: [['updatedAt', 'DESC']]
    });

    return res.json(levels);
  } catch (error) {
    console.error('Error fetching unannounced rerates:', error);
    return res.status(500).json({ error: 'Failed to fetch unannounced rerates' });
  }
});

// Mark levels as announced - single endpoint for all announcement operations
router.post('/announce', async (req: Request, res: Response) => {
  try {
    const { levelIds } = req.body;
    
    if (!Array.isArray(levelIds)) {
      return res.status(400).json({ error: 'levelIds must be an array' });
    }

    await Level.update(
      { isAnnounced: true },
      {
        where: {
          id: {
            [Op.in]: levelIds
          }
        }
      }
    );

    // Broadcast level update
    sseManager.broadcast({ type: 'levelUpdate' });

    return res.json({ success: true, message: 'Levels marked as announced' });
  } catch (error) {
    console.error('Error marking levels as announced:', error);
    return res.status(500).json({ error: 'Failed to mark levels as announced' });
  }
});

// Mark a single level as announced
router.post('/markAnnounced/:id', async (req: Request, res: Response) => {
  try {
    const levelId = parseInt(req.params.id);
    if (isNaN(levelId)) {
      return res.status(400).json({ error: 'Invalid level ID' });
    }

    const level = await Level.findByPk(levelId);
    if (!level) {
      return res.status(404).json({ error: 'Level not found' });
    }

    await level.update({ isAnnounced: true });
    
    // Broadcast level update
    sseManager.broadcast({ type: 'levelUpdate' });
    
    return res.json({ success: true });
  } catch (error) {
    console.error('Error marking level as announced:', error);
    return res.status(500).json({ 
      error: 'Failed to mark level as announced',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

// Toggle hidden status
router.patch(
  '/:id/toggle-hidden',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    const transaction = await sequelize.transaction();

    try {
      const {id} = req.params;

      const level = await Level.findOne({
        where: {id: parseInt(id)},
        transaction,
      });

      if (!level) {
        await transaction.rollback();
        return res.status(404).json({error: 'Level not found'});
      }

      // Toggle the hidden status
      await Level.update(
        {isHidden: !level.isHidden},
        {
          where: {id: parseInt(id)},
          transaction,
        },
      );

      await transaction.commit();

      // Force cache update since visibility change affects public views
      if (!req.leaderboardCache) {
        throw new Error('LeaderboardCache not initialized');
      }
      await req.leaderboardCache.forceUpdate();
      const io = getIO();
      io.emit('leaderboardUpdated');

      // Broadcast updates
      sseManager.broadcast({ type: 'levelUpdate' });

      return res.json({
        message: `Level ${level.isHidden ? 'unhidden' : 'hidden'} successfully`,
        isHidden: !level.isHidden,
      });
    } catch (error) {
      await transaction.rollback();
      console.error('Error toggling level hidden status:', error);
      return res.status(500).json({
        error: 'Failed to toggle level hidden status',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

// Add type definitions for the request body
interface DifficultyFilterBody {
  pguRange: {
    from: string | null;
    to: string | null;
  };
  specialDifficulties: string[];
}

// Add the new filtering endpoint
router.post('/filter', async (req: Request, res: Response) => {
  try {
    const { pguRange, specialDifficulties } = req.body as DifficultyFilterBody;
    const { query, sort, offset, limit, deletedFilter, clearedFilter } = req.query;

    // Build the base where clause
    const where: any = {};
    const conditions: any[] = [];

    // Handle deleted filter
    if (deletedFilter === 'hide') {
      conditions.push({
        [Op.and]: [
          {isDeleted: false},
          {isHidden: false}
        ]
      });
    } else if (deletedFilter === 'only') {
      conditions.push({
        [Op.or]: [
          {isDeleted: true},
          {isHidden: true}
        ]
      });
    }

    // Handle cleared filter
    if (clearedFilter && clearedFilter === 'hide') {
      conditions.push({
        clears: 0
      });
    } else if (clearedFilter && clearedFilter === 'only') {
      conditions.push({
        clears: {
          [Op.gt]: 0
        }
      });
    }

    // Handle text search
    if (query) {
      const searchTerm = `%${query}%`;
      conditions.push({
        [Op.or]: [
          {song: {[Op.like]: searchTerm}},
          {artist: {[Op.like]: searchTerm}},
          {charter: {[Op.like]: searchTerm}},
        ],
      });
    }

    // Handle difficulty filtering
    const difficultyConditions: any[] = [];

    // Handle PGU range if provided
    if (pguRange.from || pguRange.to) {
      const [fromDiff, toDiff] = await Promise.all([
        pguRange.from ? Difficulty.findOne({
          where: { name: pguRange.from, type: 'PGU' },
          attributes: ['id', 'sortOrder']
        }) : null,
        pguRange.to ? Difficulty.findOne({
          where: { name: pguRange.to, type: 'PGU' },
          attributes: ['id', 'sortOrder']
        }) : null
      ]);

      if (fromDiff || toDiff) {
        const pguDifficulties = await Difficulty.findAll({
          where: {
            type: 'PGU',
            sortOrder: {
              ...(fromDiff && { [Op.gte]: fromDiff.sortOrder }),
              ...(toDiff && { [Op.lte]: toDiff.sortOrder })
            }
          },
          attributes: ['id']
        });
        
        if (pguDifficulties.length > 0) {
          difficultyConditions.push({
            diffId: { [Op.in]: pguDifficulties.map(d => d.id) }
          });
        }
      }
    }

    // Handle special difficulties if provided
    if (specialDifficulties && specialDifficulties.length > 0) {
      const specialDiffs = await Difficulty.findAll({
        where: {
          name: { [Op.in]: specialDifficulties },
          type: 'SPECIAL'
        },
        attributes: ['id']
      });

      if (specialDiffs.length > 0) {
        difficultyConditions.push({
          diffId: { [Op.in]: specialDiffs.map(d => d.id) }
        });
      }
    }

    // Combine difficulty conditions with OR if both exist
    if (difficultyConditions.length > 0) {
      conditions.push({
        [Op.or]: difficultyConditions
      });
    }

    // Add placeholder exclusion
    conditions.push({
      [Op.and]: [
        {song: {[Op.ne]: 'Placeholder'}},
        {artist: {[Op.ne]: 'Placeholder'}},
        {charter: {[Op.ne]: 'Placeholder'}},
        {creator: {[Op.ne]: 'Placeholder'}},
        {publicComments: {[Op.ne]: 'Placeholder'}},
      ]
    });

    // Combine all conditions
    if (conditions.length > 0) {
      where[Op.and] = conditions;
    }

    // Get sort options
    const order = getSortOptions(sort as string);

    // First get all IDs in correct order
    const allIds = await Level.findAll({
      where,
      include: [
        {
          model: Difficulty,
          as: 'difficulty',
          required: false,
        },
      ],
      order,
      attributes: ['id'],
      raw: true,
    });

    // Then get paginated results
    const paginatedIds = allIds
      .map(level => level.id)
      .slice(Number(offset) || 0, (Number(offset) || 0) + (Number(limit) || 30));

    const results = await Level.findAll({
      where: {
        ...where,
        id: {
          [Op.in]: paginatedIds,
        },
      },
      include: [
        {
          model: Difficulty,
          as: 'difficulty',
          required: false,
        },
        {
          model: Pass,
          as: 'passes',
          required: false,
          attributes: ['id'],
        },
      ],
      order
    });

    return res.json({
      count: allIds.length,
      results,
    });
  } catch (error) {
    console.error('Error filtering levels:', error);
    return res.status(500).json({error: 'Failed to filter levels'});
  }
});

export default router;
