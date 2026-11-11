import {type Transaction} from 'sequelize';
import Level from '@/models/levels/Level.js';
import CurationRating from '@/models/curations/CurationRating.js';
import {mapMysqlClientError} from '@/misc/utils/db/mysqlClientError.js';

export async function ensureOpenCurationRating(
  levelId: number,
  transaction: Transaction,
): Promise<{rating: CurationRating; created: boolean}> {
  const level = await Level.findByPk(levelId, {transaction, lock: true});
  if (!level) {
    throw new Error(`Level ${levelId} not found`);
  }

  const existing = await CurationRating.findOne({
    where: {levelId, confirmedAt: null},
    transaction,
  });
  if (existing) {
    return {rating: existing, created: false};
  }

  try {
    const rating = await CurationRating.create(
      {
        levelId,
        confirmedAt: null,
        settledByUserId: null,
      },
      {transaction},
    );
    return {rating, created: true};
  } catch (error) {
    if (mapMysqlClientError(error)?.code !== 'ER_DUP_ENTRY') {
      throw error;
    }
    const raced = await CurationRating.findOne({
      where: {levelId, confirmedAt: null},
      transaction,
    });
    if (!raced) {
      throw error;
    }
    return {rating: raced, created: false};
  }
}

export async function confirmOpenCurationRating(
  levelId: number,
  transaction: Transaction,
  settledByUserId: string | null = null,
): Promise<number | null> {
  const existing = await CurationRating.findOne({
    where: {levelId, confirmedAt: null},
    transaction,
  });
  if (!existing) return null;
  await existing.update(
    {
      confirmedAt: new Date(),
      settledByUserId,
    },
    {transaction},
  );
  return Number(existing.id);
}
