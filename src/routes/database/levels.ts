import {Request, Response, Router} from 'express';
import {Op, OrderItem} from 'sequelize';
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

const router: Router = Router();

// Helper function to build where clause
const buildWhereClause = async (query: any) => {
  const where: any = {};
  const conditions: any[] = [];

  // Handle deleted filter
  if (query.deletedFilter === 'hide') {
    conditions.push({isDeleted: false});
  } else if (query.deletedFilter === 'only') {
    conditions.push({isDeleted: true});
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
            attributes: ['sortOrder', 'name'],
          })
        : null,
      query.maxDiff
        ? Difficulty.findOne({
            where: {name: query.maxDiff},
            attributes: ['sortOrder', 'name'],
          })
        : null,
    ]);

    if (minDiff && maxDiff && minDiff.sortOrder > maxDiff.sortOrder) {
      // Swap the difficulties if they're in wrong order
      const difficultyIds = await Difficulty.findAll({
        where: {
          sortOrder: {
            [Op.gte]: maxDiff.sortOrder,
            [Op.lte]: minDiff.sortOrder,
          },
        },
        attributes: ['id'],
      });
      conditions.push({
        diffId: {
          [Op.in]: difficultyIds.map(d => d.id),
        },
      });
    } else if (minDiff || maxDiff) {
      // Original logic for correctly ordered or single difficulty
      const difficultyIds = await Difficulty.findAll({
        where: {
          sortOrder: {
            ...(minDiff && {[Op.gte]: minDiff.sortOrder}),
            ...(maxDiff && {[Op.lte]: maxDiff.sortOrder}),
          },
        },
        attributes: ['id'],
      });
      conditions.push({
        diffId: {
          [Op.in]: difficultyIds.map(d => d.id),
        },
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

  // Combine all conditions
  if (conditions.length > 0) {
    where[Op.and] = conditions;
  }

  return where;
};
// Update the type definition
type OrderOption =
  | [string | {model: any; as: string}, string]
  | [{model: any; as: string}, string, string];

// Get sort options
const getSortOptions = (sort?: string): OrderOption[] => {
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
    default:
      return []; // No sorting, will use default database order (by ID)
  }
};

// Get all levels with filtering and pagination
router.get('/', async (req: Request, res: Response) => {
  try {
    const where = await buildWhereClause(req.query);
    const order = getSortOptions(req.query.sort as string);

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

    // Then get paginated results using those IDs in their original order
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
          await Rating.create(
            {
              levelId: levelId,
              currentDiff: '0',
              lowDiff: false,
              requesterFR: '',
              average: '',
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
      vidLink: req.body.vidLink || undefined,
      dlLink: req.body.dlLink || undefined,
      workshopLink: req.body.workshopLink || undefined,
      publicComments: req.body.publicComments || undefined,
      toRate:
        typeof req.body.toRate === 'boolean' ? req.body.toRate : level.toRate,
      rerateReason: req.body.rerateReason || undefined,
      rerateNum: req.body.rerateNum || undefined,
    };

    // Update level
    await Level.update(updateData, {
      where: {id: levelId},
      transaction,
    });

    // Fetch the updated record
    const updatedLevel = await Level.findOne({
      where: {id: levelId},
      transaction,
    });

    await transaction.commit();

    // Force cache update since level data affects pass calculations
    if (!req.leaderboardCache) {
      throw new Error('LeaderboardCache not initialized');
    }
    await req.leaderboardCache.forceUpdate();
    const io = getIO();
    io.emit('leaderboardUpdated');
    io.emit('ratingsUpdated');

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

// Soft delete a level
router.patch(
  '/:id/soft-delete',
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

      // Find and delete associated rating details and rating
      const rating = await Rating.findOne({
        where: {levelId: parseInt(id)},
        transaction,
      });

      if (rating) {
        // Delete rating details first due to foreign key constraint
        await RatingDetail.destroy({
          where: {ratingId: rating.id},
          transaction,
        });

        // Then delete the rating
        await rating.destroy({transaction});
      }

      // Soft delete the level
      await Level.update(
        {isDeleted: true},
        {
          where: {id: parseInt(id)},
          transaction,
        },
      );

      await transaction.commit();

      const io = getIO();
      io.emit('ratingsUpdated');

      return res.json({
        message: 'Level and associated ratings soft deleted successfully',
      });
    } catch (error) {
      await transaction.rollback();
      console.error('Error soft deleting level:', error);
      return res.status(500).json({error: 'Failed to soft delete level'});
    }
  },
);

// Restore a soft-deleted level
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

      // Restore the level
      await Level.update(
        {isDeleted: false},
        {
          where: {id: parseInt(id)},
          transaction,
        },
      );

      await transaction.commit();

      const io = getIO();
      io.emit('ratingsUpdated');

      return res.json({
        message: 'Level restored successfully',
      });
    } catch (error) {
      await transaction.rollback();
      console.error('Error restoring level:', error);
      return res.status(500).json({error: 'Failed to restore level'});
    }
  },
);

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
      return res.json({
        message: 'Rating removed successfully',
        toRate: false,
      });
    } else {
      // Create new rating with default values
      const newRating = await Rating.create(
        {
          levelId,
          currentDiff: '0',
          lowDiff: false,
          requesterFR: '',
          average: '',
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

      await transaction.commit();

      // Force cache update since level deletion affects pass calculations
      if (!req.leaderboardCache) {
        throw new Error('LeaderboardCache not initialized');
      }
      await req.leaderboardCache.forceUpdate();
      const io = getIO();
      io.emit('leaderboardUpdated');
      io.emit('ratingsUpdated');

      return res.json({
        message: 'Level soft deleted successfully',
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

      // Restore the level
      await Level.update(
        {isDeleted: false},
        {
          where: {id: parseInt(id)},
          transaction,
        },
      );

      await transaction.commit();

      // Force cache update since level restoration affects pass calculations
      if (!req.leaderboardCache) {
        throw new Error('LeaderboardCache not initialized');
      }
      await req.leaderboardCache.forceUpdate();
      const io = getIO();
      io.emit('leaderboardUpdated');
      io.emit('ratingsUpdated');

      return res.json({
        message: 'Level restored successfully',
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
        previousDiffId: null,
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
        previousDiffId: {
          [Op.not]: null
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

// Mark levels as announced
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

    return res.json({ success: true, message: 'Levels marked as announced' });
  } catch (error) {
    console.error('Error marking levels as announced:', error);
    return res.status(500).json({ error: 'Failed to mark levels as announced' });
  }
});

export default router;
