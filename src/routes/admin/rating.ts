import {Auth} from '../../middleware/auth.js';
import Rating from '../../models/levels/Rating.js';
import RatingDetail from '../../models/levels/RatingDetail.js';
import Level from '../../models/levels/Level.js';
import {sseManager} from '../../utils/sse.js';
import sequelize from '../../config/db.js';
import Difficulty from '../../models/levels/Difficulty.js';
import User from '../../models/auth/User.js';
import {Router, Request, Response, NextFunction} from 'express';
import Team from '../../models/credits/Team.js';
import Creator from '../../models/credits/Creator.js';
import LevelCredit from '../../models/levels/LevelCredit.js';
import { logger } from '../../services/LoggerService.js';
import { 
  getDifficulties, 
  parseRatingRange, 
  calculateRequestedDifficulty 
} from '../../utils/RatingUtils.js';
import { safeTransactionRollback } from '../../utils/Utility.js';
import { hasFlag } from '../../utils/permissionUtils.js';
import { permissionFlags } from '../../config/app.config.js';
const router: Router = Router();

// Helper function to normalize rating string and calculate average for ranges
async function normalizeRating(
  rating: string,
  transaction: any,
): Promise<{pguRating?: string; specialRatings: string[]}> {
  if (!rating) {
    return {specialRatings: []};
  }

  const {special: specialDifficulties, map: difficultyMap} = await getDifficulties(transaction);
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

  // Calculate average using sortOrder
  const avgId = Math.floor(
    pguRatings.reduce((sum, r) => sum + (r.difficulty?.id || 0), 0) / pguRatings.length
  );

  // Find the difficulty with the closest sortOrder
  const closestDifficulty = 
    Array.from(difficultyMap.values())
      .filter(d => d.type === 'PGU')
      .sort((a, b) => a.id - b.id)
      .find(d => d.id == avgId) 
      || 
    Array.from(difficultyMap.values())
      .filter(d => d.type === 'PGU')
      .sort((a, b) => b.id - a.id)[0];

  return {
    pguRating: closestDifficulty.name,
    specialRatings,
  };
}

// Helper function to calculate average rating
async function calculateAverageRating(
  detailObject: RatingDetail[],
  transaction: any,
  isCommunity: boolean = false,
) {
  const {nameMap: difficultyMap} = await getDifficulties(transaction);
  const details = detailObject
    .filter(d => d.isCommunityRating === isCommunity)
    .map((d: any) => d.dataValues);

  // Count votes for each difficulty
  const voteCounts = new Map<string, {count: number; difficulty: any}>();
  const pguVotes = new Map<number, number>(); // Map of difficulty ID to vote count

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

      // Use difficulty ID for vote counting
      const currentCount = pguVotes.get(difficulty.id) || 0;
      pguVotes.set(difficulty.id, currentCount + 1);
    }
  }

  // Check if any special rating has 4 or more votes
  const specialRatings = Array.from(voteCounts.entries())
    .filter(([_, data]) => data.difficulty.type === 'SPECIAL')
    .sort((a, b) => b[1].count - a[1].count);

  const requiredVotes = isCommunity ? 6 : 4;

  for (const [_, data] of specialRatings) {
    if (data.count >= requiredVotes) {
      return data.difficulty;
    }
  }

  // If no special rating has enough votes, calculate PGU average
  if (pguVotes.size > 0) {
    const totalVotes = Array.from(pguVotes.values()).reduce(
      (sum, count) => sum + count,
      0,
    );

    // Calculate weighted average using difficulty IDs
    const weightedAverage =
      Array.from(pguVotes.entries()).reduce(
        (sum, [diffId, count]) => sum + diffId * count,
        0,
      ) / totalVotes;

    // Find the closest PGU difficulty by ID
    const pguDifficulties = Array.from(difficultyMap.values())
      .filter(d => d.type === 'PGU')
      .sort(
        (a, b) =>
          Math.abs(a.id - weightedAverage) - Math.abs(b.id - weightedAverage),
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
              model: Difficulty,
              as: 'difficulty',
              required: false,
            },
            {
              model: Team,
              as: 'teamObject',
              required: false,
            },
            {
              model: LevelCredit,
              as: 'levelCredits',
              required: false,
              include: [
                {
                  model: Creator,
                  as: 'creator',
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
        {
          model: Difficulty,
          as: 'currentDifficulty',
          required: false,
        },
        {
          model: Difficulty,
          as: 'averageDifficulty',
          required: false,
        },
        {
          model: Difficulty,
          as: 'communityDifficulty',
          required: false,
        },
      ],
      order: [['levelId', 'ASC']],
    });

    // Calculate requestedDiffId for each rating and add it to the response
    const ratingsWithRequestedDiff = await Promise.all(
      ratings.map(async (rating) => {
        const requestedDiffId = await calculateRequestedDifficulty(
          rating.level?.rerateNum || null,
          rating.requesterFR || null,
        );
        
        // Convert to plain object and add the calculated field
        const ratingData = rating.toJSON();
        return {
          ...ratingData,
          requestedDiffId,
        };
      })
    );

    return res.json(ratingsWithRequestedDiff);
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
    const {rating, comment, isCommunityRating = false} = req.body;
    const user = req.user;

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

    if (user.player?.stats?.topDiffId == 0) {
      await safeTransactionRollback(transaction);
      return res.status(403).json({error: 'You need at least one pass to rate!'});
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
      const communityDifficulty = await calculateAverageRating(
        details,
        transaction,
        true,
      );

      // Update the main rating record
      await Rating.update(
        {
          averageDifficultyId: averageDifficulty?.id || null,
          communityDifficultyId: communityDifficulty?.id || null,
        },
        {
          where: {id: id},
          transaction,
        },
      );

      // Fetch the updated record with all associations
      const updatedRating = await Rating.findByPk(id, {
        include: [
          {
            model: Level,
            as: 'level',
            where: {
              isDeleted: false,
              isHidden: false,
            },
            include: [
              {
                model: Difficulty,
                as: 'difficulty',
                required: false,
              },
              {
                model: Team,
                as: 'teamObject',
                required: false,
              },
              {
                model: LevelCredit,
                as: 'levelCredits',
                required: false,
                include: [
                  {
                    model: Creator,
                    as: 'creator',
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
          {
            model: Difficulty,
            as: 'currentDifficulty',
            required: false,
          },
          {
            model: Difficulty,
            as: 'averageDifficulty',
            required: false,
          },
          {
            model: Difficulty,
            as: 'communityDifficulty',
            required: false,
          },
        ],
        transaction,
      });


      // Calculate requestedDiffId and add it to the response
      const requestedDiffId = updatedRating ? await calculateRequestedDifficulty(
        updatedRating.level?.rerateNum || null,
        updatedRating.requesterFR || null
      ) : null;

      const ratingData = updatedRating ? updatedRating.toJSON() : null;
      const responseData = ratingData ? {
        ...ratingData,
        requestedDiffId,
      } : null;

      // Broadcast rating update via SSE
      sseManager.broadcast({type: 'ratingUpdate'});

      await transaction.commit();
      return res.json({
        message: 'Rating detail deleted successfully',
        rating: responseData,
      });
    }

    // Find or create rating detail
    const [ratingDetail] = await RatingDetail.findOrCreate({
      where: {
        ratingId: Number(id),
        userId: user.id,
      },
      defaults: {
        ratingId: Number(id),
        userId: user.id,
        rating: rating || '',
        comment: comment || '',
        isCommunityRating,
      },
      transaction,
    });

    // Only update if the detail already existed and values changed
    if (
      ratingDetail &&
      (ratingDetail.rating !== rating ||
        ratingDetail.comment !== comment ||
        ratingDetail.isCommunityRating !== isCommunityRating)
    ) {
      await ratingDetail.update(
        {
          rating: rating || '',
          comment: comment || '',
          isCommunityRating,
        },
        {transaction},
      );
    }

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
    // Find the rating record
    const ratingRecord = await Rating.findByPk(id, {
      include: [
        {
          model: Level,
          as: 'level',
          where: {
            isDeleted: false,
            isHidden: false,
          },
          include: [
            {
              model: Difficulty,
              as: 'difficulty',
              required: false,
            },
            {
              model: Team,
              as: 'teamObject',
              required: false,
            },
            {
              model: LevelCredit,
              as: 'levelCredits',
              required: false,
              include: [
                {
                  model: Creator,
                  as: 'creator',
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
        {
          model: Difficulty,
          as: 'currentDifficulty',
          required: false,
        },
        {
          model: Difficulty,
          as: 'averageDifficulty',
          required: false,
        },
        {
          model: Difficulty,
          as: 'communityDifficulty',
          required: false,
        },
      ],
      transaction,
    });

    if (!ratingRecord) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({error: 'Rating not found'});
    }

    // Find the difficulty if it exists (for current difficulty)
    const difficulty = await Difficulty.findOne({
      where: {name: rating},
      transaction,
    });

    // Update the main rating record with current and average difficulties
    await ratingRecord.update(
      {
        currentDifficultyId:
          !isCommunityRating && difficulty ? difficulty.id : null,
        averageDifficultyId: averageDifficulty?.id || null,
        communityDifficultyId: communityDifficulty?.id || null,
      },
      {transaction},
    );

    // Fetch the updated record with all associations
    const updatedRating = await Rating.findByPk(id, {
      include: [
        {
          model: Level,
          as: 'level',
          where: {
            isDeleted: false,
            isHidden: false,
          },
          include: [
            {
              model: Difficulty,
              as: 'difficulty',
              required: false,
            },
            {
              model: Team,
              as: 'teamObject',
              required: false,
            },
            {
              model: LevelCredit,
              as: 'levelCredits',
              required: false,
              include: [
                {
                  model: Creator,
                  as: 'creator',
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
        {
          model: Difficulty,
          as: 'currentDifficulty',
          required: false,
        },
        {
          model: Difficulty,
          as: 'averageDifficulty',
          required: false,
        },
        {
          model: Difficulty,
          as: 'communityDifficulty',
          required: false,
        },
      ],
      transaction,
    });


    // Calculate requestedDiffId and add it to the response
    const requestedDiffId = updatedRating ? await calculateRequestedDifficulty(
      updatedRating.level?.rerateNum || null,
      updatedRating.requesterFR || null
    ) : null;

    const ratingData = updatedRating ? updatedRating.toJSON() : null;
    const responseData = ratingData ? {
      ...ratingData,
      requestedDiffId,
    } : null;

    // Broadcast rating update via SSE
    sseManager.broadcast({type: 'ratingUpdate'});

    await transaction.commit();

    return res.json({
      message: 'Rating updated successfully',
      rating: responseData,
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

      // Get remaining rating details
      const details = await RatingDetail.findAll({
        where: { 
          ratingId: id
        },
        transaction,
      });

      // Calculate new average difficulty
      const averageDifficulty = await calculateAverageRating(
        details,
        transaction,
      );

      // Update the main rating record
      await Rating.update(
        {
          averageDifficultyId: averageDifficulty?.id || null,
        },
        {
          where: {id: id},
          transaction,
        },
      );

      // Fetch the updated record with all associations
      const updatedRating = await Rating.findByPk(id, {
        include: [
          {
            model: Level,
            as: 'level',
            where: {
              isDeleted: false,
              isHidden: false,
            },
            include: [
              {
                model: Difficulty,
                as: 'difficulty',
                required: false,
              },
              {
                model: Team,
                as: 'teamObject',
                required: false,
              },
              {
                model: LevelCredit,
                as: 'levelCredits',
                required: false,
                include: [
                  {
                    model: Creator,
                    as: 'creator',
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
          {
            model: Difficulty,
            as: 'currentDifficulty',
            required: false,
          },
          {
            model: Difficulty,
            as: 'averageDifficulty',
            required: false,
          },
        ],
        transaction,
      });

      // Calculate requestedDiffId and add it to the response
      const requestedDiffId = updatedRating ? await calculateRequestedDifficulty(
        updatedRating.level?.rerateNum || null,
        updatedRating.requesterFR || null
      ) : null;

      const ratingData = updatedRating ? updatedRating.toJSON() : null;
      const responseData = ratingData ? {
        ...ratingData,
        requestedDiffId,
      } : null;

      // Broadcast rating update via SSE
      sseManager.broadcast({type: 'ratingUpdate'});

      await transaction.commit();

      return res.json({
        message: 'Rating detail confirmed successfully',
        rating: responseData,
      });
    } catch (error: unknown) {
      await safeTransactionRollback(transaction);
      logger.error('Error confirming rating detail:', error);
      return res.status(500).json({error: 'Failed to confirm rating detail'});
    }
  },
);

export default router;
