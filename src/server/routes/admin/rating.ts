import {Auth} from '../../middleware/auth.js';
import Rating from '../../../models/levels/Rating.js';
import RatingDetail from '../../../models/levels/RatingDetail.js';
import Level from '../../../models/levels/Level.js';
import {sseManager} from '../../../misc/utils/server/sse.js';
import sequelize from '../../../config/db.js';
import Difficulty from '../../../models/levels/Difficulty.js';
import User from '../../../models/auth/User.js';
import {Router, Request, Response, NextFunction} from 'express';
import Team from '../../../models/credits/Team.js';
import Creator from '../../../models/credits/Creator.js';
import LevelCredit from '../../../models/levels/LevelCredit.js';
import { logger } from '../../services/LoggerService.js';
import {
  getDifficulties,
  parseRatingRange
} from '../../../misc/utils/data/RatingUtils.js';
import { safeTransactionRollback } from '../../../misc/utils/Utility.js';
import { hasFlag } from '../../../misc/utils/auth/permissionUtils.js';
import { permissionFlags } from '../../../config/constants.js';
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

// Helper function to normalize rating string and calculate average for ranges
async function normalizeRating(
  rating: string,
  transaction: any,
): Promise<{pguRating?: string; specialRatings: string[]}> {
  if (!rating) {
    return {specialRatings: []};
  }

  const {special: specialDifficulties, nameMap: difficultyMap} = await getDifficulties(transaction);

  const parts = await parseRatingRange(rating, specialDifficulties);
  // If it's not a range, just normalize the single rating
  if (parts.length === 1) {
    // First check if it's a special difficulty directly
    if (specialDifficulties.has(parts[0])) {
      return {specialRatings: [parts[0]]};
    }

    const match = parts[0].match(/([PGUpgu])(-?\d+)/);
    logger.debug(`[RatingService] single rating match: ${match} for ${parts[0]}`);
    if (!match || !match[1]) {
      return {specialRatings: []};
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const [_, prefix, num] = match;
    const normalizedRating = prefix.toUpperCase() + num;

    // Check if it's a special difficulty after normalization
    if (specialDifficulties.has(normalizedRating)) {
      return {specialRatings: [normalizedRating]};
    }

    return {
      pguRating: normalizedRating,
      specialRatings: [],
    };
  }

  // Process range
  type RatingInfo = {
    raw: string;
    isSpecial: boolean;
    difficulty?: any;
    sortOrder?: number;
  };

  const ratings = parts
    .map(r => {
      // First check if it's a special rating as is
      if (specialDifficulties.has(r)) {
        const difficulty = difficultyMap.get(r);
        return {
          raw: r,
          isSpecial: true,
          difficulty,
          sortOrder: difficulty?.sortOrder
        } as RatingInfo;
      }

      const match = r.match(/([PGUpgu]*)(-?\d+)/);
      logger.debug(`[RatingService] match: ${match} for ${r}`);
      if (!match || !match[1]) {
        return null;
      }
      const prefix = match[1].toUpperCase();
      const num = match[2];
      const normalizedName = `${prefix}${num}`;
      const difficulty = difficultyMap.get(normalizedName);
      return difficulty ? {
        raw: normalizedName,
        isSpecial: false,
        difficulty,
        sortOrder: difficulty.sortOrder
      } as RatingInfo : null;
    })
    .filter((r): r is RatingInfo => r !== null);

  if (ratings.length !== 2) {
    return {specialRatings: []};
  }

  // Collect special ratings
  const specialRatings = ratings.filter(r => r.isSpecial).map(r => r.raw);

  // Find PGU ratings
  const pguRatings = ratings.filter(r => !r.isSpecial && r.difficulty);
  if (pguRatings.length === 0) {
    return {specialRatings};
  }

  if (pguRatings.length === 1) {
    return {
      pguRating: pguRatings[0].raw,
      specialRatings,
    };
  }

  // Average by sortOrder and find closest PGU by sortOrder
  const avgSortOrder =
    pguRatings.reduce((sum, r) => sum + (r.difficulty?.sortOrder ?? 0), 0) / pguRatings.length;

  const pguDifficulties = Array.from(difficultyMap.values())
    .filter(d => d.type === 'PGU')
    .sort(
      (a, b) =>
        Math.abs(a.sortOrder - avgSortOrder) - Math.abs(b.sortOrder - avgSortOrder),
    );
  const closestDifficulty = pguDifficulties[0];

  return {
    pguRating: closestDifficulty?.name,
    specialRatings,
  };
}

// Helper function to calculate average rating
async function calculateAverageRating(
  detailObject: RatingDetail[],
  transaction: any,
  isCommunity = false,
) {
  const {nameMap: difficultyMap} = await getDifficulties(transaction);
  const details = detailObject
    .filter(d => d.isCommunityRating === isCommunity)
    .map((d: any) => d.dataValues);

  // Count votes for each difficulty
  const voteCounts = new Map<string, {count: number; difficulty: any}>();
  const pguVotes = new Map<number, number>(); // Map of sortOrder to vote count

  // First pass: Count all votes
  for (const detail of details) {
    if (!detail.rating) continue;

    const {pguRating, specialRatings} = await normalizeRating(
      detail.rating,
      transaction,
    );
    // Process special ratings first
    for (const specialRating of specialRatings) {
      const difficulty = difficultyMap.get(specialRating);
      if (!difficulty || difficulty.type !== 'SPECIAL') continue;

      const current = voteCounts.get(specialRating) || {count: 0, difficulty};
      current.count++;
      voteCounts.set(specialRating, current);
    }

    // Process PGU rating if present
    if (pguRating) {
      const difficulty = difficultyMap.get(pguRating);
      if (!difficulty || difficulty.type !== 'PGU') continue;

      const currentCount = pguVotes.get(difficulty.sortOrder) ?? 0;
      pguVotes.set(difficulty.sortOrder, currentCount + 1);
    }
  }

  // Check if any special rating has 4 or more votes
  const specialRatings = Array.from(voteCounts.entries())
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    .filter(([_, data]) => data.difficulty.type === 'SPECIAL')
    .sort((a, b) => b[1].count - a[1].count);

  const requiredVotes = isCommunity ? 6 : 4;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for (const [_, data] of specialRatings) {
    if (data.count >= requiredVotes) {
      return data.difficulty;
    }
  }

  // If no special rating has enough votes, calculate PGU average by sortOrder
  if (pguVotes.size > 0) {
    const totalVotes = Array.from(pguVotes.values()).reduce(
      (sum, count) => sum + count,
      0,
    );

    const weightedAvgSortOrder =
      Array.from(pguVotes.entries()).reduce(
        (sum, [sortOrder, count]) => sum + sortOrder * count,
        0,
      ) / totalVotes;

    const pguDifficulties = Array.from(difficultyMap.values())
      .filter(d => d.type === 'PGU')
      .sort(
        (a, b) =>
          Math.abs(a.sortOrder - weightedAvgSortOrder) -
          Math.abs(b.sortOrder - weightedAvgSortOrder),
      );

    if (pguDifficulties.length > 0) {
      return pguDifficulties[0];
    }
  }
  

  return null;
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
