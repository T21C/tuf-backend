import axios from 'axios';
import sequelize from '@/config/db.js';
import Level from '@/models/levels/Level.js';
import Rating from '@/models/levels/Rating.js';
import RatingDetail from '@/models/levels/RatingDetail.js';
import { calculateAverageRating } from '@/misc/utils/data/RatingUtils.js';
import { parseAutoraterCombined } from '@/misc/utils/data/ratingFlow.js';
import { safeTransactionRollback } from '@/misc/utils/Utility.js';
import { CacheInvalidation } from '@/server/middleware/cache.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { broadcastRatingUpsert } from '@/server/services/ratings/ratingListService.js';

const AUTORATER_UUID = process.env.AUTORATER_UUID;
if (!AUTORATER_UUID) {
  throw new Error('AUTORATER_UUID is not set');
}
const autoraterUserId: string = AUTORATER_UUID;

const AUTORATER_EMBED_URL = 'https://www.auto-rater-cat.com/embed/tuf';

export class AutoraterError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'AutoraterError';
  }
}

export interface AutorateResult {
  response: unknown;
}

class AutoraterService {
  private static instance: AutoraterService;

  private constructor() {}

  public static getInstance(): AutoraterService {
    if (!AutoraterService.instance) {
      AutoraterService.instance = new AutoraterService();
    }
    return AutoraterService.instance;
  }

  async autorateRating(ratingId: number): Promise<AutorateResult> {
    let transaction: Awaited<ReturnType<typeof sequelize.transaction>> | undefined;
    try {
      transaction = await sequelize.transaction();

      const rating = await Rating.findByPk(ratingId, {transaction});
      if (!rating) {
        throw new AutoraterError('Rating not found', 404);
      }
      if (rating.confirmedAt != null) {
        throw new AutoraterError('Cannot autorate a settled rating', 409);
      }
      if (!rating.levelId) {
        throw new AutoraterError('Level ID is required', 400);
      }

      const level = await Level.findByPk(rating.levelId);
      if (!level || level.isDeleted || level.isHidden) {
        throw new AutoraterError('Level not found', 404);
      }

      const response = await axios.get(`${AUTORATER_EMBED_URL}/${rating.levelId}/rating`, {
        timeout: 20000,
      });
      if (response.status !== 200) {
        throw new AutoraterError('Failed to autorate level', 502, response.data);
      }

      const combined = parseAutoraterCombined(response.data);
      if (!combined) {
        const inProgress = Boolean((response.data as { rating_in_progress?: boolean })?.rating_in_progress);
        throw new AutoraterError(
          inProgress ? 'Autorater result is still in progress' : 'Autorater has no combined tier',
          409,
          response.data,
        );
      }

      const comment = [
        `Combined: ${combined.tier}${combined.value != null ? ` (${combined.value})` : ''}`,
        combined.rule ? `Rule: ${combined.rule}` : '',
        combined.used.length > 0 ? `Used: ${combined.used.join(', ')}` : '',
      ].filter(Boolean).join('\n');

      await RatingDetail.upsert({
        ratingId,
        userId: autoraterUserId,
        rating: combined.tier,
        comment,
        isCommunityRating: false,
      });

      const details = await RatingDetail.findAll({
        where: { ratingId },
        transaction,
      });
      const averageDifficulty = await calculateAverageRating(details, transaction);
      const communityDifficulty = await calculateAverageRating(details, transaction, true);
      await Rating.update(
        {
          averageDifficultyId: averageDifficulty?.id ?? null,
          communityDifficultyId: communityDifficulty?.id ?? null,
          autoraterCombined: {
            tier: combined.tier,
            value: combined.value,
            used: combined.used,
            rule: combined.rule,
            modelFingerprint: combined.modelFingerprint,
          },
        },
        { where: { id: ratingId }, transaction },
      );
      await transaction.commit();
      transaction = undefined;

      await CacheInvalidation.invalidateTag('admin:ratings').catch((cacheError) => {
        logger.error('admin ratings cache invalidation failed after autorate', cacheError);
      });
      await broadcastRatingUpsert(ratingId, rating.levelId).catch((broadcastError) => {
        logger.error('rating list broadcast failed after autorate', broadcastError);
      });

      return { response: response.data };
    } catch (error) {
      await safeTransactionRollback(transaction);
      if (error instanceof AutoraterError) {
        throw error;
      }
      if (axios.isAxiosError(error)) {
        throw new AutoraterError('Failed to autorate level', error.response?.status || 500, error.response?.data);
      }
      logger.error('Error autorating level:', error);
      throw new AutoraterError('Failed to autorate level', 500);
    }
  }
}

export const autoraterService = AutoraterService.getInstance();
export default AutoraterService;
