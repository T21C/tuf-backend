import {Auth} from '@/server/middleware/auth.js';
import Rating from '@/models/levels/Rating.js';
import RatingDetail from '@/models/levels/RatingDetail.js';
import Level from '@/models/levels/Level.js';
import {sseManager} from '@/misc/utils/server/sse.js';
import sequelize from '@/config/db.js';
import Difficulty from '@/models/levels/Difficulty.js';
import User from '@/models/auth/User.js';
import {Router, Request, Response, NextFunction} from 'express';
import Team from '@/models/credits/Team.js';
import Creator from '@/models/credits/Creator.js';
import LevelCredit from '@/models/levels/LevelCredit.js';
import { logger } from '@/server/services/LoggerService.js';
import { calculateAverageRating } from '@/misc/utils/data/RatingUtils.js';
import { safeTransactionRollback } from '@/misc/utils/Utility.js';
import { hasFlag } from '@/misc/utils/auth/permissionUtils.js';
import { permissionFlags } from '@/config/constants.js';
const router: Router = Router();

/** Reusable options for fetching a rating with full includes (level, details, difficulties). */
function fullRatingIncludeOptions(transaction: any) {
  return {
    include: [
      {
        model: Level,
        as: 'level',
        where: { isDeleted: false, isHidden: false },
        required: false,
        include: [
          { model: Difficulty, as: 'difficulty', required: false },
          { model: Team, as: 'teamObject', required: false },
          {
            model: LevelCredit,
            as: 'levelCredits',
            required: false,
            include: [{ model: Creator, as: 'creator' }],
          },
        ],
      },
      {
        model: RatingDetail,
        as: 'details',
        include: [
          {
            model: User,
            as: 'user',
            attributes: ['id', 'username', 'nickname', 'avatarUrl'],
          },
        ],
      },
      { model: Difficulty, as: 'averageDifficulty', required: false },
      { model: Difficulty, as: 'communityDifficulty', required: false },
    ],
    transaction,
  };
}


router.get('/', async (req: Request, res: Response) => {
  try {
    const ratings = await Rating.findAll({
      where: {
        confirmedAt: null
      },
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
              model: Team,
              as: 'teamObject',
              attributes: ['name'],
              required: false,
            },
            {
              model: LevelCredit,
              as: 'levelCredits',
              required: false,
              attributes: ['id', 'role'],
              include: [
                {
                  model: Creator,
                  as: 'creator',
                  attributes: ['name', 'id'],
                },
              ],
            },
          ],
        },
        {
          model: RatingDetail,
          as: 'details',
          include: [
            {
              model: User,
              as: 'user',
              attributes: ['id', 'username', 'nickname', 'avatarUrl'],
            },
          ],
        },
      ],
      order: [['levelId', 'ASC']],
    });

    return res.json(ratings);
  } catch (error) {
    logger.error('Error fetching ratings:', error);
    return res.status(500).json({error: 'Internal Server Error'});
  }
});

// Update rating
router.put('/:id', Auth.verified(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();

  try {
    const {id} = req.params;
    const {rating: ratingString, comment: commentString, isCommunityRating = false} = req.body;
    const user = req.user;
    const rating = typeof ratingString === 'string' ? ratingString.slice(0, 254) : '';
    const comment = typeof commentString === 'string' ? commentString.slice(0, 254) : '';
    // Get user to check permissions
    if (!user) {
      await safeTransactionRollback(transaction);
      return res.status(401).json({error: 'User not found'});
    }

    // Check if user is banned from rating
    if (hasFlag(user, permissionFlags.RATING_BANNED)) {
      await safeTransactionRollback(transaction);
      return res.status(403).json({error: 'User is banned from rating'});
    }

    // For non-community ratings, require rater permission
    if (!isCommunityRating && !hasFlag(user, permissionFlags.RATER)) {
      await safeTransactionRollback(transaction);
      return res.status(403).json({error: 'User is not a rater'});
    }
    // If rating is empty or null, treat it as a deletion request
    if (!rating || rating.trim() === '') {
      // Delete the rating detail
      await RatingDetail.destroy({
        where: {
          ratingId: id,
          userId: user.id,
        },
        transaction,
      });

      // Get remaining rating details
      const details = await RatingDetail.findAll({
        where: {ratingId: id},
        transaction,
      });

      // Calculate new average difficulties for both rater and community ratings
      const averageDifficulty = await calculateAverageRating(details, transaction);
      logger.debug(`[RatingService] averageDifficulty: ${averageDifficulty} for ${rating}`);
      const communityDifficulty = await calculateAverageRating(
        details,
        transaction,
        true,
      );

      await Rating.update(
        {
          averageDifficultyId: averageDifficulty?.id ?? null,
          communityDifficultyId: communityDifficulty?.id ?? null,
        },
        { where: { id }, transaction },
      );

      const updatedRating = await Rating.findByPk(id, fullRatingIncludeOptions(transaction));

      sseManager.broadcast({ type: 'ratingUpdate' });
      await transaction.commit();
      return res.json({
        message: 'Rating detail deleted successfully',
        rating: updatedRating,
      });
    }

    // Upsert rating detail (insert or update in one step)
    await RatingDetail.upsert(
      {
        ratingId: Number(id),
        userId: user.id,
        rating: rating || '',
        comment: comment || '',
        isCommunityRating,
      },
      { transaction },
    );

    // Get all rating details for this rating
    const details = await RatingDetail.findAll({
      where: {ratingId: id},
      transaction,
    });

    // Calculate new average difficulties for both rater and community ratings
    const averageDifficulty = await calculateAverageRating(details, transaction);
    const communityDifficulty = await calculateAverageRating(
      details,
      transaction,
      true,
    );

    const [updatedCount] = await Rating.update(
      {
        averageDifficultyId: averageDifficulty?.id ?? null,
        communityDifficultyId: communityDifficulty?.id ?? null,
      },
      { where: { id }, transaction },
    );
    if (updatedCount === 0) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({ error: 'Rating not found' });
    }

    const updatedRating = await Rating.findByPk(id, fullRatingIncludeOptions(transaction));

    // Broadcast rating update via SSE
    sseManager.broadcast({type: 'ratingUpdate'});

    await transaction.commit();

    return res.json({
      message: 'Rating updated successfully',
      rating: updatedRating,
    });
  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error updating rating:', error);
    return res.status(500).json({error: 'Failed to update rating'});
  }
});

// Delete rating detail
router.delete(
  '/:id/detail/:userId',
  [
    Auth.rater(),
    async (req: Request, res: Response, next: NextFunction) => {
      // Check if it's the user's own rating
      if (req.user?.id === req.params.userId) {
        return next();
      }
      // If not own rating, require super admin
      return Auth.superAdmin()(req, res, next);
    },
  ],
  async (req: Request, res: Response) => {
    const transaction = await sequelize.transaction();

    try {
      const {id, userId} = req.params;
      const currentUser = req.user;
      if (!currentUser) {
        await safeTransactionRollback(transaction);
        return res.status(401).json({error: 'User not authenticated'});
      }

      await RatingDetail.destroy({
        where: {
          ratingId: id,
          userId: userId,
        },
        transaction,
      });

      const details = await RatingDetail.findAll({
        where: { ratingId: id },
        transaction,
      });

      const averageDifficulty = await calculateAverageRating(details, transaction);
      const communityDifficulty = await calculateAverageRating(
        details,
        transaction,
        true,
      );

      await Rating.update(
        {
          averageDifficultyId: averageDifficulty?.id ?? null,
          communityDifficultyId: communityDifficulty?.id ?? null,
        },
        { where: { id }, transaction },
      );

      const updatedRating = await Rating.findByPk(id, fullRatingIncludeOptions(transaction));

      sseManager.broadcast({ type: 'ratingUpdate' });
      await transaction.commit();
      return res.json({
        message: 'Rating detail confirmed successfully',
        rating: updatedRating,
      });
    } catch (error: unknown) {
      await safeTransactionRollback(transaction);
      logger.error('Error confirming rating detail:', error);
      return res.status(500).json({error: 'Failed to confirm rating detail'});
    }
  },
);

export default router;
