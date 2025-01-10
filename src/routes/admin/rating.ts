import { Router, Request, Response, NextFunction } from 'express';
import { Auth } from '../../middleware/auth';
import Rating from '../../models/Rating';
import RatingDetail from '../../models/RatingDetail';
import Level from '../../models/Level';
import { sseManager } from '../../utils/sse';
import sequelize from '../../config/db';
import Difficulty from '../../models/Difficulty';
import { Op, fn, col, literal } from 'sequelize';
import User from '../../models/User';

const router: Router = Router();

// Cache for difficulties to avoid repeated DB queries
let difficultyCache: { 
  special: Set<string>,
  map: Map<string, any>
} | null = null;

// Helper function to get difficulties
async function getDifficulties(transaction: any) {
  if (!difficultyCache) {
    const difficulties = await Difficulty.findAll({
      transaction,
      order: [['sortOrder', 'ASC']]
    });

    difficultyCache = {
      special: new Set(difficulties.filter(d => d.type === 'SPECIAL').map(d => d.name)),
      map: new Map(difficulties.map(d => [d.name, d]))
    };
  }
  return difficultyCache;
}

// Helper function to parse complex rating string
async function parseRatingRange(rating: string, specialDifficulties: Set<string>): Promise<string[]> {
  // First check if the entire rating is a special difficulty
  if (specialDifficulties.has(rating.trim())) {
    return [rating.trim()];
  }
  
  // Find the first separator, but be careful with negative numbers
  // Look for separator only if it's not part of a negative number
  const match = rating.match(/([^-~\s]+|^-\d+)([-~\s])(.+)/);
  if (!match) {
    return [rating.trim()];
  }

  const [_, firstPart, separator, lastPart] = match;
 
  // Check if second part is a special rating before any processing
  if (specialDifficulties.has(lastPart)) {
    return [firstPart, lastPart];
  }

  // For number-only second parts in ranges like "U11-13", copy the prefix
  const firstMatch = firstPart.match(/([A-Za-z]*)(-?\d+)/);
  const lastMatch = lastPart.match(/([A-Za-z]*)(-?\d+)/);
  
  if (firstMatch && lastMatch) {
    const [_, firstPrefix, firstNum] = firstMatch;
    const [__, lastPrefix, lastNum] = lastMatch;
    
    // If second part has no prefix and first part does, copy the prefix
    // BUT only if it's not a special rating
    if (!lastPrefix && firstPrefix) {
      const rawSecondPart = lastNum;
      if (specialDifficulties.has(rawSecondPart)) {
        return [firstPart, rawSecondPart];
      }
      return [firstPart, `${firstPrefix}${lastNum}`];
    }
  }

  return [firstPart, lastPart];
}

// Helper function to normalize rating string and calculate average for ranges
async function normalizeRating(rating: string, transaction: any): Promise<{ pguRating?: string, specialRatings: string[] }> {
  if (!rating) {
    return { specialRatings: [] };
  }

  const { special: specialDifficulties } = await getDifficulties(transaction);
  const parts = await parseRatingRange(rating, specialDifficulties);
  
  // If it's not a range, just normalize the single rating
  if (parts.length === 1) {
    // First check if it's a special difficulty directly
    if (specialDifficulties.has(parts[0])) {
      return { specialRatings: [parts[0]] };
    }

    const match = parts[0].match(/([A-Za-z]*)(-?\d+)/);
    if (!match) {
      return { specialRatings: [] };
    }
    const [_, prefix, num] = match;
    const normalizedRating = (prefix || 'G').toUpperCase() + num;

    // Check if it's a special difficulty after normalization
    if (specialDifficulties.has(normalizedRating)) {
      return { specialRatings: [normalizedRating] };
    }

    return { 
      pguRating: normalizedRating,
      specialRatings: []
    };
  }

  // Process range
  type RatingInfo = { 
    raw: string; 
    isSpecial: boolean; 
    prefix?: string; 
    number?: number;
  };

  const ratings = parts.map(r => {
    // First check if it's a special rating as is
    if (specialDifficulties.has(r)) {
      return { raw: r, isSpecial: true } as RatingInfo;
    }

    const match = r.match(/([A-Za-z]*)(-?\d+)/);
    if (!match) {
      return null;
    }
    const prefix = (match[1] || 'G').toUpperCase();
    const number = parseInt(match[2]);
    const raw = `${prefix}${number}`;
    const isSpecial = specialDifficulties.has(raw);
    return { prefix, number, raw, isSpecial } as RatingInfo;
  }).filter((r): r is RatingInfo => r !== null);

  if (ratings.length !== 2) {
    return { specialRatings: [] };
  }

  // Collect special ratings (check against actual special difficulties)
  const specialRatings = ratings
    .filter(r => r.isSpecial)
    .map(r => r.raw);

  // Find PGU ratings (those that aren't special)
  const pguRatings = ratings
    .filter(r => !r.isSpecial && r.number !== undefined && r.prefix !== undefined)
    .map(r => ({ prefix: r.prefix!, number: r.number!, raw: r.raw }));

  if (pguRatings.length === 0) {
    return { specialRatings };
  }

  if (pguRatings.length === 1) {
    // If only one PGU rating, use it directly
    return {
      pguRating: pguRatings[0].raw,
      specialRatings
    };
  }

  // Calculate average of PGU ratings
  const avgNumber = Math.round(pguRatings.reduce((sum, r) => sum + r.number, 0) / pguRatings.length);
  // Use common prefix if same, otherwise default to G
  const prefix = pguRatings.every(r => r.prefix === pguRatings[0].prefix) ? pguRatings[0].prefix : 'G';
  const pguRating = `${prefix}${avgNumber}`;

  return {
    pguRating,
    specialRatings
  };
}

// Helper function to calculate average rating
async function calculateAverageRating(detailObject: RatingDetail[], transaction: any) {
  const { map: difficultyMap } = await getDifficulties(transaction);
  const details = detailObject.map(d => d.dataValues);
  
  // Count votes for each difficulty
  const voteCounts = new Map<string, { count: number, difficulty: any }>();
  const pguVotes = new Map<number, number>(); // Map of difficulty ID to vote count

  // First pass: Count all votes
  for (const detail of details) {
    if (!detail.rating) continue;
    
    const { pguRating, specialRatings } = await normalizeRating(detail.rating, transaction);

    // Process special ratings first
    for (const specialRating of specialRatings) {
      const difficulty = difficultyMap.get(specialRating);
      if (!difficulty || difficulty.type !== 'SPECIAL') continue;
      
      const current = voteCounts.get(specialRating) || { count: 0, difficulty };
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

  for (const [_, data] of specialRatings) {
    if (data.count >= 4) {
      return data.difficulty;
    }
  }

  // If no special rating has 4+ votes, calculate PGU average
  if (pguVotes.size > 0) {
    const totalVotes = Array.from(pguVotes.values()).reduce((sum, count) => sum + count, 0);
    
    // Calculate weighted average using difficulty IDs
    const weightedAverage = Array.from(pguVotes.entries())
      .reduce((sum, [diffId, count]) => sum + (diffId * count), 0) / totalVotes;
    
    // Find the closest PGU difficulty by ID
    const pguDifficulties = Array.from(difficultyMap.values())
      .filter(d => d.type === 'PGU')
      .sort((a, b) => Math.abs(a.id - weightedAverage) - Math.abs(b.id - weightedAverage));

    if (pguDifficulties.length > 0) {
      return pguDifficulties[0];
    }
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
          include: [{
            model: User,
            as: 'user',
            attributes: ['id', 'username', 'nickname', 'avatarUrl']
          }]
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
    const userId = req.user?.id;

    if (!userId) {
      await transaction.rollback();
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // If both rating and comment are empty, treat it as a deletion request
    if (!rating && !comment) {
      // Delete the rating detail
      await RatingDetail.destroy({
        where: {
          ratingId: id,
          userId: userId
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
            include: [{
              model: User,
              as: 'user',
              attributes: ['id', 'username', 'nickname', 'avatarUrl']
            }]
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
        userId: userId
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
          include: [{
            model: User,
            as: 'user',
            attributes: ['id', 'username', 'nickname', 'avatarUrl']
          }]
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
          include: [{
            model: User,
            as: 'user',
            attributes: ['id', 'username', 'nickname', 'avatarUrl']
          }]
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
router.delete('/:id/detail/:userId', [Auth.rater(), async (req: Request, res: Response, next: NextFunction) => {
  // Check if it's the user's own rating
  if (req.user?.id === req.params.userId) {
    return next();
  }
  // If not own rating, require super admin
  return Auth.superAdmin()(req, res, next);
}], async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();

  try {
    const { id, userId } = req.params;
    const currentUser = req.user;
    if (!currentUser) {
      await transaction.rollback();
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Delete the rating detail
    await RatingDetail.destroy({
      where: {
        ratingId: id,
        userId: userId
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
              required: false
            }
          ]
        },
        {
          model: RatingDetail,
          as: 'details',
          include: [{
            model: User,
            as: 'user',
            attributes: ['id', 'username', 'nickname', 'avatarUrl']
          }]
        },
        {
          model: Difficulty,
          as: 'currentDifficulty',
          required: false
        },
        {
          model: Difficulty,
          as: 'averageDifficulty',
          required: false
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
  } catch (error: unknown) {
    await transaction.rollback();
    console.error('Error deleting rating detail:', error);
    return res.status(500).json({ error: 'Failed to delete rating detail' });
  }
});

export default router;
