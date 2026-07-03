import axios from 'axios';
import sequelize from '@/config/db.js';
import Level from '@/models/levels/Level.js';
import Difficulty from '@/models/levels/Difficulty.js';
import Rating from '@/models/levels/Rating.js';
import RatingDetail from '@/models/levels/RatingDetail.js';
import { calculateAverageRating } from '@/misc/utils/data/RatingUtils.js';
import { safeTransactionRollback } from '@/misc/utils/Utility.js';
import cdnService from '@/server/services/core/CdnService.js';
import { logger } from '@/server/services/core/LoggerService.js';

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
    let transaction: Awaited<ReturnType<typeof sequelize.transaction>> | undefined;
    try {
      transaction = await sequelize.transaction();

      const rating = await Rating.findByPk(ratingId);
      if (!rating) {
        throw new AutoraterError('Rating not found', 404);
      }
      if (!rating.levelId) {
        throw new AutoraterError('Level ID is required', 400);
      }

      const level = await Level.findByPk(rating.levelId);
      if (!level || level.isDeleted || level.isHidden) {
        throw new AutoraterError('Level not found', 404);
      }

      const levelFile =
        (await cdnService.getLevelAdofai(level)) ||
        (await fetch(
          'https://api.tuforums.com/v2/database/levels/' + rating.levelId + '/level.adofai',
        ).then((res) => res.json()));
      if (!levelFile) {
        throw new AutoraterError('No level file available', 404);
      }

      const requestBody = {
        Content: levelFile,
        techMode: 'both',
      };

      const response = await axios.post(`${process.env.OWOSEAN_API_URL}/rate`, requestBody, {
        timeout: 20000,
      });
      if (response.status !== 200) {
        throw new AutoraterError('Failed to autorate level', 500, response.data);
      }

      logger.debug('Autorate response:', response.data);
      const result = response.data;
      const normal = result.normal;
      const tech = result.tech;

      const normalRatingRange = normal.tuf_diff_id_range as [number, number];
      const techRatingRange = tech.tuf_diff_id_range as [number, number];

      const getComment = (input: {
        range: number[];
        difficulty: string;
        index_key_count: number[];
        roll_key_count: number[];
        warnings: unknown[];
        similar_level?: unknown[];
        similar_raw_diff: string;
      }) => {
        return [
          `  Range: [${input.range.join('-')}] (${input.difficulty} raw diff)`,
          `  Key Count:`,
          `  Index: [${input.index_key_count.join(', ')}] | Roll: [${input.roll_key_count.join(', ')}]`,
          `  Warnings: ${input.warnings.length || 'None'}`,
          `  Similar Level: ${input.similar_level?.[0] ?? ''} (${input.similar_raw_diff} raw diff)`,
        ];
      };
      const comment = [
        `Normal`,
        ...getComment(normal),
        ``,
        `Tech`,
        ...getComment(tech),
      ].join('\n');

      const idRatingRanges = [...normalRatingRange, ...techRatingRange];
      const [minId, maxId] = [Math.min(...idRatingRanges), Math.max(...idRatingRanges)];
      const [minDifficulty, maxDifficulty] = await Promise.all([
        minId ? Difficulty.findByPk(minId) : Difficulty.findOne({ where: { name: 'Qq' } }),
        maxId ? Difficulty.findByPk(maxId) : Difficulty.findOne({ where: { name: 'Qq' } }),
      ]);

      if (!minDifficulty || !maxDifficulty) {
        logger.warn('Difficulty not found', { minId, maxId });
        throw new AutoraterError('Failed to autorate level', 502, 'Difficulty not found');
      }

      const ratingRange = `${minDifficulty.name}-${maxDifficulty.name}`;

      await RatingDetail.upsert({
        ratingId: ratingId,
        userId: autoraterUserId,
        rating: ratingRange,
        comment: comment,
        isCommunityRating: false,
      });

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
      if (axios.isAxiosError(error) && error.response) {
        throw new AutoraterError('Failed to autorate level', 500, error.response.data);
      }
      logger.error('Error autorating level:', error);
      throw new AutoraterError('Failed to autorate level', 500);
    }
  }
}

export const autoraterService = AutoraterService.getInstance();
export default AutoraterService;
