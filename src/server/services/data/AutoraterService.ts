import axios from 'axios';
import Level from '@/models/levels/Level.js';
import Rating from '@/models/levels/Rating.js';
import RatingDetail from '@/models/levels/RatingDetail.js';
import { calculateAverageRating } from '@/misc/utils/data/RatingUtils.js';
import { safeTransactionRollback } from '@/misc/utils/Utility.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { validateAutoraterResult } from '@/misc/utils/data/autoraterResult.js';
import type {Transaction} from 'sequelize';

const AUTORATER_UUID = process.env.AUTORATER_UUID;
if (!AUTORATER_UUID) {
  throw new Error('AUTORATER_UUID is not set');
}
const autoraterUserId: string = AUTORATER_UUID;

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
    let transaction: Transaction | undefined;
    try {
      const rating = await Rating.findByPk(ratingId);
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

      const apiUrl = (process.env.AUTORATER_API_URL ||
        'https://auto-rater-cat-v2-api-production.up.railway.app').replace(/\/+$/, '');
      const response = await axios.get(`${apiUrl}/rating-result`, {
        params: {tufid: rating.levelId},
        timeout: 190000,
      });
      if (response.status !== 200) {
        throw new AutoraterError('Failed to autorate level', 502);
      }

      let result;
      try {
        result = validateAutoraterResult(response.data, rating.levelId);
      } catch {
        throw new AutoraterError('AutoRater returned an invalid rating result', 502);
      }

      // Do not hold a database connection during model inference. Recheck settlement
      // under the same levels-pool transaction used to save the detail and averages.
      transaction = await Rating.sequelize!.transaction();
      const current = await Rating.findByPk(ratingId, {transaction, lock: transaction.LOCK.UPDATE});
      if (!current) throw new AutoraterError('Rating not found', 404);
      if (current.confirmedAt != null || current.levelId !== rating.levelId) {
        throw new AutoraterError('Rating changed while AutoRater was running', 409);
      }
      const currentLevel = await Level.findByPk(current.levelId, {transaction});
      if (!currentLevel || currentLevel.isDeleted || currentLevel.isHidden) {
        throw new AutoraterError('Level not found', 404);
      }

      await RatingDetail.upsert({
        ratingId: ratingId,
        userId: autoraterUserId,
        rating: result.rating_result,
        comment: '',
        isCommunityRating: false,
      }, {transaction});

      const details = await RatingDetail.findAll({
        where: { ratingId: ratingId },
        transaction,
      });
      const averageDifficulty = await calculateAverageRating(details, transaction);
      logger.debug(`[AutoraterService] averageDifficulty: ${averageDifficulty} for rating ${ratingId}`);
      const communityDifficulty = await calculateAverageRating(details, transaction, true);
      await Rating.update(
        {
          averageDifficultyId: averageDifficulty?.id ?? null,
          communityDifficultyId: communityDifficulty?.id ?? null,
        },
        { where: { id: ratingId }, transaction },
      );
      await transaction.commit();

      return { response: response.data };
    } catch (error) {
      await safeTransactionRollback(transaction);
      if (error instanceof AutoraterError) {
        throw error;
      }
      if (axios.isAxiosError(error)) {
        const upstreamStatus = error.response?.status;
        const status = error.code === 'ECONNABORTED' ? 504
          : upstreamStatus && [404, 413, 422, 503, 504].includes(upstreamStatus) ? upstreamStatus : 502;
        throw new AutoraterError('Failed to autorate level. The previous rating has been kept.', status);
      }
      logger.error('Error autorating level:', error);
      throw new AutoraterError('Failed to autorate level', 500);
    }
  }
}

export const autoraterService = AutoraterService.getInstance();
export default AutoraterService;
