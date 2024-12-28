import { Router, Request, Response } from 'express';
import { Auth } from '../../middleware/auth';
import Rating from '../../models/Rating';
import RatingDetail from '../../models/RatingDetail';
import Level from '../../models/Level';
import { sseManager } from '../../utils/sse';
import sequelize from '../../config/db';
import Difficulty from '../../models/Difficulty';
import { Op, fn, col, literal } from 'sequelize';

const router: Router = Router();

// Helper function to normalize rating string
function normalizeRating(rating: string): string {
  return rating.trim().toUpperCase();
}

// Helper function to calculate average rating
async function calculateAverageRating(detailObject: RatingDetail[], transaction: any) {
  // Get all difficulties for efficient querying
  const details = detailObject.map(d => d.dataValues);
  const difficulties = await Difficulty.findAll({
    transaction,
    order: [['sortOrder', 'ASC']]
  });

  // Create maps for quick lookups
  const difficultyMap = new Map(
    difficulties.map(d => [normalizeRating(d.name), d])
  );

  // Count votes for each difficulty
  const voteCounts = new Map<string, { count: number, difficulty: any }>();

  for (const detail of details) {
    if (!detail.rating) continue;
    
    const normalizedRating = normalizeRating(detail.rating);
    const difficulty = difficultyMap.get(normalizedRating);
    
    // Skip if rating doesn't match a known difficulty
    if (!difficulty) continue;

    const current = voteCounts.get(normalizedRating) || { count: 0, difficulty };
    current.count++;
    voteCounts.set(normalizedRating, current);
  }

  // Check if any special rating has 4 or more votes
  for (const [_, data] of voteCounts) {
    if (data.difficulty.type === 'SPECIAL' && data.count >= 4) {
      return data.difficulty;
    }
  }

  // Calculate average for PGU ratings
  const pguVotes = Array.from(voteCounts.values())
    .filter(({ difficulty }) => difficulty.type === 'PGU');

  if (pguVotes.length > 0) {
    // Calculate weighted average based on vote counts
    const totalVotes = pguVotes.reduce((sum, { count }) => sum + count, 0);
    const weightedSortOrder = pguVotes.reduce((sum, { difficulty, count }) => 
      sum + (difficulty.sortOrder * count), 0) / totalVotes;
    
    // Find the closest PGU difficulty by sortOrder
    const closestDifficulty = difficulties
      .filter(d => d.type === 'PGU')
      .reduce((prev, curr) => {
        return Math.abs(curr.sortOrder - weightedSortOrder) < Math.abs(prev.sortOrder - weightedSortOrder)
          ? curr
          : prev;
      });
    
    return closestDifficulty;
  }

  return null;
}

// Get all ratings
router.get('/', Auth.rater(), async (req: Request, res: Response) => {
  try {
    const ratings = await Rating.findAll({
      include: [
        {
          model: Level,
          as: 'level',
          where: {
            isDeleted: false,
            isHidden: false
          },
          include: [
            {
              model: Difficulty,
              as: 'difficulty',
              required: false,
            }
          ],
        },
        {
          model: RatingDetail,
          as: 'details',
        },
        {
          model: Difficulty,
          as: 'currentDifficulty',
          required: false,
        },
        {
          model: Difficulty,
          as: 'averageDifficulty',
          required: false,
        }
      ],
      order: [['levelId', 'ASC']],
    });

    return res.json(ratings);
  } catch (error) {
    console.error('Error fetching ratings:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Update rating
router.put('/:id', Auth.rater(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();

  try {
    const { id } = req.params;
    const { rating, comment } = req.body;
    const username = req.user?.username;

    if (!username) {
      await transaction.rollback();
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // If both rating and comment are empty, treat it as a deletion request
    if (!rating && !comment) {
      // Delete the rating detail
      await RatingDetail.destroy({
        where: {
          ratingId: id,
          username: username
        },
        transaction
      });

      // Get remaining rating details
      const details = await RatingDetail.findAll({
        where: { ratingId: id },
        transaction
      });

      // Calculate new average difficulty
      const averageDifficulty = await calculateAverageRating(details, transaction);

      // Update the main rating record
      await Rating.update({
        averageDifficultyId: averageDifficulty?.id || null,
      }, {
        where: { id: id },
        transaction
      });

      // Fetch the updated record with all associations
      const updatedRating = await Rating.findByPk(id, {
        include: [
          {
            model: Level,
            as: 'level',
            where: {
              isDeleted: false,
              isHidden: false
            },
            include: [
              {
                model: Difficulty,
                as: 'difficulty',
                required: false,
              }
            ],
          },
          {
            model: RatingDetail,
            as: 'details',
          },
          {
            model: Difficulty,
            as: 'currentDifficulty',
            required: false,
          },
          {
            model: Difficulty,
            as: 'averageDifficulty',
            required: false,
          }
        ],
        transaction
      });

      await transaction.commit();

      // Broadcast rating update via SSE
      sseManager.broadcast({ type: 'ratingUpdate' });

      return res.json({
        message: 'Rating detail deleted successfully',
        rating: updatedRating
      });
    }

    // Find or create rating detail without validation
    const [ratingDetail] = await RatingDetail.findOrCreate({
      where: {
        ratingId: id,
        username: username
      },
      defaults: {
        rating: rating,
        comment: comment || '',
      },
      transaction
    });

    if (ratingDetail) {
      await ratingDetail.update({
        rating: rating,
        comment: comment || ratingDetail.comment,
      }, { transaction });
    }

    // Get all rating details for this rating
    const details = await RatingDetail.findAll({
      where: { ratingId: id },
      transaction
    });

    // Calculate new average difficulty (this will only use valid difficulty ratings)
    const averageDifficulty = await calculateAverageRating(details, transaction);

    // Find the rating record
    const ratingRecord = await Rating.findByPk(id, {
      include: [
        {
          model: Level,
          as: 'level',
          where: {
            isDeleted: false,
            isHidden: false
          },
          include: [
            {
              model: Difficulty,
              as: 'difficulty',
              required: false,
            }
          ],
        },
        {
          model: RatingDetail,
          as: 'details',
        },
        {
          model: Difficulty,
          as: 'currentDifficulty',
          required: false,
        },
        {
          model: Difficulty,
          as: 'averageDifficulty',
          required: false,
        }
      ],
      transaction
    });

    if (!ratingRecord) {
      await transaction.rollback();
      return res.status(404).json({ error: 'Rating not found' });
    }

    // Find the difficulty if it exists (for current difficulty)
    const difficulty = await Difficulty.findOne({
      where: { name: rating },
      transaction
    });

    // Update the main rating record with current and average difficulties
    await ratingRecord.update({
      currentDifficultyId: difficulty?.id || null,
      averageDifficultyId: averageDifficulty?.id || null,
    }, { transaction });

    // Fetch the updated record with all associations
    const updatedRating = await Rating.findByPk(id, {
      include: [
        {
          model: Level,
          as: 'level',
          where: {
            isDeleted: false,
            isHidden: false
          },
          include: [
            {
              model: Difficulty,
              as: 'difficulty',
              required: false,
            }
          ],
        },
        {
          model: RatingDetail,
          as: 'details',
        },
        {
          model: Difficulty,
          as: 'currentDifficulty',
          required: false,
        },
        {
          model: Difficulty,
          as: 'averageDifficulty',
          required: false,
        }
      ],
      transaction
    });

    await transaction.commit();

    // Broadcast rating update via SSE
    sseManager.broadcast({ type: 'ratingUpdate' });

    return res.json({
      message: 'Rating updated successfully',
      rating: updatedRating
    });
  } catch (error) {
    await transaction.rollback();
    console.error('Error updating rating:', error);
    return res.status(500).json({ error: 'Failed to update rating' });
  }
});

// Delete rating detail
router.delete('/:id/detail/:username', Auth.rater(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();

  try {
    const { id, username } = req.params;
    const currentUser = req.user?.username;

    if (!currentUser) {
      await transaction.rollback();
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Only allow users to delete their own ratings or super admins to delete any
    if (!req.user?.isSuperAdmin && currentUser !== username) {
      await transaction.rollback();
      return res.status(403).json({ error: 'Not authorized to delete this rating' });
    }

    // Delete the rating detail
    await RatingDetail.destroy({
      where: {
        ratingId: id,
        username: username
      },
      transaction
    });

    // Get remaining rating details
    const details = await RatingDetail.findAll({
      where: { ratingId: id },
      transaction
    });

    // Calculate new average difficulty
    const averageDifficulty = await calculateAverageRating(details, transaction);

    // Update the main rating record
    await Rating.update({
      averageDifficultyId: averageDifficulty?.id || null,
    }, {
      where: { id: id },
      transaction
    });

    await transaction.commit();

    // Broadcast rating update via SSE
    sseManager.broadcast({ type: 'ratingUpdate' });

    return res.json({
      message: 'Rating detail deleted successfully'
    });
  } catch (error) {
    await transaction.rollback();
    console.error('Error deleting rating detail:', error);
    return res.status(500).json({ error: 'Failed to delete rating detail' });
  }
});

export default router;
