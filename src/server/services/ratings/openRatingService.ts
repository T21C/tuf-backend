import {type Transaction} from 'sequelize';
import Level from '@/models/levels/Level.js';
import Rating from '@/models/levels/Rating.js';
import {mapMysqlClientError} from '@/misc/utils/db/mysqlClientError.js';

export type EnsureOpenRatingAttrs = {
  lowDiff?: boolean;
  requesterFR?: string;
  averageDifficultyId?: number | null;
  communityDifficultyId?: number | null;
};

export async function ensureOpenRating(
  levelId: number,
  attrs: EnsureOpenRatingAttrs,
  transaction: Transaction,
): Promise<{rating: Rating; created: boolean}> {
  const level = await Level.findByPk(levelId, {transaction, lock: true});
  if (!level) {
    throw new Error(`Level ${levelId} not found`);
  }

  const existing = await Rating.findOne({
    where: {levelId, confirmedAt: null},
    transaction,
  });
  if (existing) {
    return {rating: existing, created: false};
  }

  try {
    const rating = await Rating.create(
      {
        levelId,
        lowDiff: attrs.lowDiff ?? false,
        requesterFR: attrs.requesterFR ?? '',
        averageDifficultyId: attrs.averageDifficultyId ?? null,
        communityDifficultyId: attrs.communityDifficultyId ?? null,
        confirmedAt: null,
      },
      {transaction},
    );
    return {rating, created: true};
  } catch (error) {
    if (mapMysqlClientError(error)?.code !== 'ER_DUP_ENTRY') {
      throw error;
    }
    const raced = await Rating.findOne({
      where: {levelId, confirmedAt: null},
      transaction,
    });
    if (!raced) {
      throw error;
    }
    return {rating: raced, created: false};
  }
}
