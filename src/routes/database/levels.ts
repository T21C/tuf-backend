import {Request, Response, Router} from 'express';
import {Op, OrderItem} from 'sequelize';
import Level from '../../models/Level';
import Pass from '../../models/Pass';
import Rating from '../../models/Rating';
import Player from '../../models/Player';
import Judgement from '../../models/Judgement';
import {calculateBaseScore, calculatePGUDiffNum} from '../../utils/ratingUtils';
import {Auth} from '../../middleware/auth';
import {getIO} from '../../utils/socket';
import sequelize from '../../config/db';
import RatingDetail from '../../models/RatingDetail';
import Difficulty from '../../models/Difficulty';

const router: Router = Router();

// Helper function to build where clause
const buildWhereClause = (query: any) => {
  const where: any = {};
  const conditions: any[] = [];

  // Handle deleted filter
  if (query.deletedFilter === 'hide') {
    conditions.push({isDeleted: false});
  } else if (query.deletedFilter === 'only') {
    conditions.push({isDeleted: true});
  }
  // 'show' case doesn't need any condition as it shows both

  // Text search conditions
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

  // Specific field searches
  if (query.artistQuery)
    conditions.push({artist: {[Op.like]: `%${query.artistQuery}%`}});
  if (query.songQuery)
    conditions.push({song: {[Op.like]: `%${query.songQuery}%`}});
  if (query.charterQuery)
    conditions.push({charter: {[Op.like]: `%${query.charterQuery}%`}});

  // Difficulty filters
  const diffConditions: any[] = [];
  if (query.hideCensored === 'true') diffConditions.push({[Op.ne]: -2});
  if (query.hideEpic === 'true') diffConditions.push({[Op.ne]: 0.9});
  if (query.hideUnranked === 'true') diffConditions.push({[Op.ne]: 0});

  if (diffConditions.length > 0) {
    conditions.push({diff: {[Op.and]: diffConditions}});
  }

  // PGU difficulty range
  const pguConditions: any[] = [];
  if (query.minDiff) pguConditions.push({[Op.gte]: Number(query.minDiff)});
  if (query.maxDiff) pguConditions.push({[Op.lte]: Number(query.maxDiff)});

  if (pguConditions.length > 0) {
    conditions.push({pguDiffNum: {[Op.and]: pguConditions}});
  }

  // Combine all conditions with AND
  if (conditions.length > 0) {
    where[Op.and] = conditions;
  }

  return where;
};

// Get sort options
const getSortOptions = (sort?: string) => {
  switch (sort) {
    case 'RECENT_DESC':
      return [['id', 'DESC']];
    case 'RECENT_ASC':
      return [['id', 'ASC']];
    case 'DIFF_DESC':
      return [['diffId', 'DESC']];
    case 'DIFF_ASC':
      return [['diffId', 'ASC']];
    default:
      return [['id', 'DESC']];
  }
};

// Get all levels with filtering and pagination
router.get('/', async (req: Request, res: Response) => {
  try {
    const routeStart = performance.now();

    if (req.query.sort === 'RANDOM') {
      const where = buildWhereClause(req.query);
      const count = await Level.count({where});

      // Get all IDs that match the criteria
      const allIds = await Level.findAll({
        where,
        attributes: ['id'],
        raw: true,
      });

      // Shuffle IDs
      const shuffledIds = allIds
        .map(item => item.id)
        .sort(() => Math.random() - 0.5);

      // Get paginated results
      const offset = req.query.offset ? Number(req.query.offset) : 0;
      const limit = req.query.limit ? Number(req.query.limit) : undefined;

      const results = await Level.findAll({
        where: {
          id: {
            [Op.in]: shuffledIds.slice(
              offset,
              limit ? offset + limit : undefined,
            ),
          },
        },
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

      return res.json({count, results});
    }

    // Normal sorting
    const results = await Level.findAll({
      where: buildWhereClause(req.query),
      order: getSortOptions(req.query.sort as string) as OrderItem[],
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
      offset: req.query.offset ? Number(req.query.offset) : 0,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });

    const count = await Level.count({where: buildWhereClause(req.query)});

    const totalTime = performance.now() - routeStart;
    console.log(`[PERF] Total route time: ${totalTime.toFixed(2)}ms`);

    return res.json({count, results});
  } catch (error) {
    console.error('Error fetching levels:', error);
    return res.status(500).json({error: 'Failed to fetch levels'});
  }
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

    // Calculate new pguDiffNum if pguDiffNum is being updated
    let pguDiffNum = level.diffId;
    let baseScore = level.baseScore;
    if (req.body.diffId && req.body.diffId !== level.diffId) {
      pguDiffNum = calculatePGUDiffNum(req.body.pguDiff);
      baseScore = calculateBaseScore(req.body.pguDiffNum);
    }

    // Calculate new baseScore if diff is being updated

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
      baseScore: baseScore || undefined,
      isCleared:
        typeof req.body.isCleared === 'boolean'
          ? req.body.isCleared
          : level.isCleared,
      clears:
        typeof req.body.clears === 'number' ? req.body.clears : level.clears,
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

    const io = getIO();
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

export default router;
