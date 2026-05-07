import type {Transaction} from 'sequelize';
import sequelize from '@/config/db.js';
import Level from '@/models/levels/Level.js';
import Curation from '@/models/curations/Curation.js';
import Pass from '@/models/passes/Pass.js';
import DirectiveConditionHistory from '@/models/announcements/DirectiveConditionHistory.js';
import LevelRerateHistory from '@/models/levels/LevelRerateHistory.js';
import {logger} from '@/server/services/core/LoggerService.js';
import {getFileIdFromCdnUrl, isCdnUrl, safeTransactionRollback} from '@/misc/utils/Utility.js';
import cdnService from '@/server/services/core/CdnService.js';

export type PermanentLevelDeleteOptions = {
  /** When true (default), only soft-deleted levels may be removed. */
  requireSoftDeleted?: boolean;
};

/**
 * Hard-delete a single level inside an open transaction (DB + CDN file cleanup).
 * Does not commit, run Elasticsearch, SSE, or HTTP cache — callers do that after commit.
 *
 * `DirectiveConditionHistory` uses a separate Sequelize pool; it is cleared without joining
 * the same transaction (matches legacy route behavior).
 */
export async function permanentDeleteLevelInTransaction(
  levelId: number,
  transaction: Transaction,
  options: PermanentLevelDeleteOptions = {},
): Promise<void> {
  const requireSoftDeleted = options.requireSoftDeleted !== false;

  const level = await Level.findOne({
    where: {id: levelId},
    include: [
      {
        model: Curation,
        as: 'curations',
        required: false,
      },
    ],
    transaction,
  });

  if (!level) {
    throw new Error('LEVEL_NOT_FOUND');
  }

  if (requireSoftDeleted && !level.isDeleted) {
    throw new Error('LEVEL_NOT_SOFT_DELETED');
  }

  await DirectiveConditionHistory.destroy({
    where: {levelId},
  });

  const curations = Array.isArray(level.curations) ? level.curations : [];

  if (level.fileId && level.dlLink && level.dlLink !== 'removed' && isCdnUrl(level.dlLink)) {
    try {
      logger.debug(`Permanent delete: removing level zip from CDN: ${level.fileId}`);
      await cdnService.deleteFile(level.fileId);
    } catch (cdnErr) {
      logger.error(`Permanent delete: CDN level zip delete failed for ${level.fileId}:`, cdnErr);
    }
  }

  for (const curation of curations) {
    if (curation.previewLink && isCdnUrl(curation.previewLink)) {
      const thumbId = getFileIdFromCdnUrl(curation.previewLink);
      if (thumbId) {
        try {
          logger.debug(`Permanent delete: removing curation preview from CDN: ${thumbId}`);
          await cdnService.deleteFile(thumbId);
        } catch (cdnErr) {
          logger.error(
            `Permanent delete: CDN curation preview delete failed for ${thumbId}:`,
            cdnErr,
          );
        }
      }
    }
  }

  await LevelRerateHistory.destroy({
    where: {levelId},
    transaction,
  });

  const deletedCount = await Level.destroy({
    where: {id: levelId},
    transaction,
  });

  if (deletedCount === 0) {
    throw new Error('LEVEL_NOT_FOUND');
  }
}

/**
 * Full permanent delete with transaction lifecycle + post-commit side effects.
 * @returns affected player ids for reindexing (from passes before delete)
 */
export async function executePermanentLevelDeleteWithSideEffects(
  levelId: number,
  options: PermanentLevelDeleteOptions,
  sideEffects: {
    elasticsearchDeleteLevel: (id: number) => Promise<void>;
    broadcastAndInvalidate: (input: {levelId: number; affectedPlayerIds: number[]}) => Promise<void>;
  },
): Promise<{affectedPlayerIds: number[]}> {
  const passRows = await Pass.findAll({
    where: {levelId},
    attributes: ['playerId'],
  });
  const affectedPlayerIds = Array.from(
    new Set(passRows.map(p => p.playerId).filter((x): x is number => typeof x === 'number')),
  );

  let transaction: Transaction | undefined;
  try {
    transaction = await sequelize.transaction();
    await permanentDeleteLevelInTransaction(levelId, transaction, options);
    await transaction.commit();
    transaction = undefined;

    try {
      await sideEffects.elasticsearchDeleteLevel(levelId);
    } catch (esErr) {
      logger.error(`Permanent delete: Elasticsearch level doc delete failed for ${levelId}:`, esErr);
    }

    await sideEffects.broadcastAndInvalidate({levelId, affectedPlayerIds});

    return {affectedPlayerIds};
  } catch (error) {
    await safeTransactionRollback(transaction);
    throw error;
  }
}
