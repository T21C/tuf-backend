import sequelize from '@/config/db.js';
import User from '@/models/auth/User.js';
import Player from '@/models/players/Player.js';
import Pass from '@/models/passes/Pass.js';
import Creator from '@/models/credits/Creator.js';
import cdnService from '@/server/services/CdnService.js';
import { logger } from '@/server/services/LoggerService.js';
import { permissionFlags } from '@/config/constants.js';
import { hasFlag, setUserPermissionAndSave } from '@/misc/utils/auth/permissionUtils.js';
import { safeTransactionRollback } from '@/misc/utils/Utility.js';
import ElasticsearchService from '@/server/services/ElasticsearchService.js';
import { CacheInvalidation } from '@/server/middleware/cache.js';

const GRACE_PERIOD_MS = 3 * 24 * 60 * 60 * 1000;

export class AccountDeletionService {
  private static instance: AccountDeletionService;

  private async cleanupExternalUserContent(input: {
    userId: string;
    avatarId?: string | null;
  }): Promise<void> {
    await this.cleanupCdnUserContent(input);
  }

  /**
   * DB CASCADE removes passes without Sequelize per-row hooks; sync Elasticsearch + HTTP cache.
   */
  private async syncSearchAndCacheAfterHardDelete(input: {
    userId: string;
    passIds: number[];
    levelIds: number[];
  }): Promise<void> {
    const es = ElasticsearchService.getInstance();
    try {
      if (input.passIds.length > 0) {
        await es.bulkDeletePassDocumentsFromIndex(input.passIds);
      }
      if (input.levelIds.length > 0) {
        await es.reindexLevels(input.levelIds);
      }
    } catch (err) {
      logger.error('[AccountDeletion] Elasticsearch sync after hard delete failed', {
        userId: input.userId,
        message: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      const tags = new Set<string>([
        'Passes',
        'Profile',
        'levels:all',
        `user:${input.userId}`,
      ]);
      for (const id of input.levelIds) {
        tags.add(`level:${id}`);
      }
      await CacheInvalidation.invalidateTags([...tags]);
    } catch (cacheErr) {
      logger.warn('[AccountDeletion] Cache invalidation after hard delete failed', {
        userId: input.userId,
        message: cacheErr instanceof Error ? cacheErr.message : String(cacheErr),
      });
    }
  }

  private async cleanupCdnUserContent(input: {
    userId: string;
    avatarId?: string | null;
  }): Promise<void> {
    const avatarId = input.avatarId ?? null;
    if (!avatarId) return;

    try {
      if (await cdnService.checkFileExists(avatarId)) {
        logger.debug('[AccountDeletion] Deleting avatar from CDN', {
          userId: input.userId,
          avatarId,
        });
        await cdnService.deleteFile(avatarId);
      }
    } catch (cdnErr) {
      logger.warn('[AccountDeletion] CDN cleanup failed', {
        userId: input.userId,
        avatarId,
        message: cdnErr instanceof Error ? cdnErr.message : String(cdnErr),
      });
    }
  }

  public static getInstance(): AccountDeletionService {
    if (!AccountDeletionService.instance) {
      AccountDeletionService.instance = new AccountDeletionService();
    }
    return AccountDeletionService.instance;
  }

  /**
   * Schedule deletion with 3-day grace period.
   * - Snapshots permission flags once (for safe restore)
   * - Bans player (leaderboard hidden) and sets BANNED permission flag
   */
  public async scheduleDeletion(userId: string): Promise<{
    deletionScheduledAt: Date;
    deletionExecuteAt: Date;
  }> {
    let transaction: any;

    try {
      transaction = await sequelize.transaction();
      const user = await User.findByPk(userId, { transaction });
      if (!user) {
        throw new Error('User not found');
      }

      const now = new Date();
      const executeAt = new Date(now.getTime() + GRACE_PERIOD_MS);

      // Snapshot original permission flags only the first time we schedule.
      const snapshot =
        user.deletionSnapshotPermissionFlags ?? (user.permissionFlags as any);

      await user.update(
        {
          deletionScheduledAt: user.deletionScheduledAt ?? now,
          deletionExecuteAt: executeAt,
          deletionSnapshotPermissionFlags: snapshot,
        },
        { transaction },
      );

      // Ban player immediately so they disappear from leaderboard.
      const player = await Player.findByPk(user.playerId, { transaction });
      if (player) {
        await player.update({ isBanned: true }, { transaction });
      }

      await setUserPermissionAndSave(user, permissionFlags.BANNED, true, transaction);

      const playerIdForEs = user.playerId ?? null;

      await transaction.commit();

      try {
        await CacheInvalidation.invalidateTags(['Passes', 'Profile', `user:${userId}`]);
      } catch (cacheErr) {
        logger.warn('[AccountDeletion] Cache invalidation after schedule failed', {
          userId,
          message: cacheErr instanceof Error ? cacheErr.message : String(cacheErr),
        });
      }

      if (playerIdForEs != null) {
        try {
          await ElasticsearchService.getInstance().updatePlayerPasses(playerIdForEs);
        } catch (esErr) {
          logger.warn('[AccountDeletion] Elasticsearch updatePlayerPasses after schedule failed', {
            userId,
            playerId: playerIdForEs,
            message: esErr instanceof Error ? esErr.message : String(esErr),
          });
        }
      }

      return { deletionScheduledAt: user.deletionScheduledAt ?? now, deletionExecuteAt: executeAt };
    } catch (error) {
      await safeTransactionRollback(transaction);
      throw error;
    }
  }

  /**
   * Cancel a scheduled deletion.
   * - Clears deletion schedule fields
   * - Restores permissionFlags from snapshot
   * - Restores player ban state based on snapshot (prevents ban-evasion)
   */
  public async cancelDeletion(userId: string): Promise<void> {
    let transaction: any;

    try {
      transaction = await sequelize.transaction();
      const user = await User.findByPk(userId, { transaction });
      if (!user) {
        throw new Error('User not found');
      }

      const snapshot = user.deletionSnapshotPermissionFlags;
      const snapshotFlags =
        snapshot === null || snapshot === undefined ? user.permissionFlags : snapshot;

      await user.update(
        {
          deletionScheduledAt: null,
          deletionExecuteAt: null,
          deletionSnapshotPermissionFlags: null,
          permissionFlags: snapshotFlags as any,
        },
        { transaction },
      );

      // Restore player ban state using the snapshot flags (not current flags).
      const shouldBeBanned = hasFlag(
        { ...(user as any), permissionFlags: snapshotFlags },
        permissionFlags.BANNED,
      );

      const player = await Player.findByPk(user.playerId, { transaction });
      if (player) {
        await player.update({ isBanned: shouldBeBanned }, { transaction });
      }

      await user.increment('permissionVersion', { by: 1, transaction });

      const playerIdForEs = user.playerId ?? null;

      await transaction.commit();

      try {
        await CacheInvalidation.invalidateTags(['Passes', 'Profile', `user:${userId}`]);
      } catch (cacheErr) {
        logger.warn('[AccountDeletion] Cache invalidation after cancel failed', {
          userId,
          message: cacheErr instanceof Error ? cacheErr.message : String(cacheErr),
        });
      }

      if (playerIdForEs != null) {
        try {
          await ElasticsearchService.getInstance().updatePlayerPasses(playerIdForEs);
        } catch (esErr) {
          logger.warn('[AccountDeletion] Elasticsearch updatePlayerPasses after cancel failed', {
            userId,
            playerId: playerIdForEs,
            message: esErr instanceof Error ? esErr.message : String(esErr),
          });
        }
      }
    } catch (error) {
      await safeTransactionRollback(transaction);
      throw error;
    }
  }

  /**
   * Permanently delete the account if it is scheduled and due.
   * The database cascades take care of most user-bound content, but player deletion
   * is performed separately to support the legacy player-owned pass tree.
   */
  public async executeHardDeleteIfDue(userId: string): Promise<boolean> {
    const user = await User.findByPk(userId);
    if (!user) return false;

    if (!user.deletionExecuteAt || !user.deletionScheduledAt) return false;
    if (user.deletionExecuteAt.getTime() > Date.now()) return false;

    let transaction: any;
    let avatarIdToDelete: string | null = null;
    let playerIdToDelete: number | null = null;

    try {
      transaction = await sequelize.transaction();
      const lockedUser = await User.findByPk(userId, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!lockedUser) {
        await transaction.commit();
        return false;
      }

      // Re-check under lock (could have been canceled).
      if (!lockedUser.deletionExecuteAt || !lockedUser.deletionScheduledAt) {
        await transaction.commit();
        return false;
      }
      if (lockedUser.deletionExecuteAt.getTime() > Date.now()) {
        await transaction.commit();
        return false;
      }

      avatarIdToDelete = lockedUser.avatarId ?? null;
      playerIdToDelete = lockedUser.playerId ?? null;

      let passIdsForSearchIndex: number[] = [];
      let levelIdsAffected: number[] = [];
      if (playerIdToDelete) {
        const passRows = await Pass.findAll({
          where: { playerId: playerIdToDelete },
          attributes: ['id', 'levelId'],
          transaction,
        });
        passIdsForSearchIndex = passRows.map((p) => p.id);
        levelIdsAffected = [
          ...new Set(passRows.map((p) => p.levelId).filter((id): id is number => id != null)),
        ];
      }

      // Ensure creator persists but is unlinked.
      await Creator.update(
        { userId: null },
        { where: { userId: lockedUser.id }, transaction },
      );

      // Delete user first (users->players FK blocks deleting player while user exists).
      await User.destroy({ where: { id: lockedUser.id }, transaction });

      // Delete player after user is gone so passes cascade away.
      if (playerIdToDelete) {
        await Player.destroy({ where: { id: playerIdToDelete }, transaction });
      }

      await transaction.commit();

      // External cleanup AFTER commit (best-effort).
      await this.cleanupExternalUserContent({
        userId,
        avatarId: avatarIdToDelete,
      });

      await this.syncSearchAndCacheAfterHardDelete({
        userId,
        passIds: passIdsForSearchIndex,
        levelIds: levelIdsAffected,
      });

      return true;
    } catch (error) {
      await safeTransactionRollback(transaction);
      logger.error('[AccountDeletion] Hard delete failed', {
        userId,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }
}

