import Creator from '@/models/credits/Creator.js';
import { CreatorAlias } from '@/models/credits/CreatorAlias.js';
import User from '@/models/auth/User.js';
import LevelCredit from '@/models/levels/LevelCredit.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { extractNumericIdsFromSequelizeWhereField } from '@/server/services/elasticsearch/misc/extractNumericIdsFromSequelizeWhereField.js';

export interface CreatorIndexHookApi {
  indexCreator(creatorId: number): Promise<void>;
  reindexCreators(creatorIds: number[]): Promise<void>;
  deleteCreatorDocumentById(creatorId: number): Promise<void>;
}

async function runAfterCommit(
  options: { transaction?: { afterCommit: (fn: () => void | Promise<void>) => Promise<unknown> } },
  fn: () => Promise<void>,
): Promise<void> {
  if (options.transaction) {
    await options.transaction.afterCommit(fn);
  } else {
    await fn();
  }
}

export function registerCreatorIndexChangeListeners(api: CreatorIndexHookApi): void {
  // Remove any existing hooks with the same names (support hot reload).
  Creator.removeHook('afterSave', 'creatorIndexAfterSave');
  Creator.removeHook('afterCreate', 'creatorIndexAfterCreate');
  Creator.removeHook('afterDestroy', 'creatorIndexAfterDestroy');
  Creator.removeHook('afterBulkUpdate', 'creatorIndexBulkUpdate');

  CreatorAlias.removeHook('afterSave', 'creatorIndexAliasAfterSave');
  CreatorAlias.removeHook('afterDestroy', 'creatorIndexAliasAfterDestroy');

  User.removeHook('afterSave', 'creatorIndexUserAfterSave');
  User.removeHook('afterDestroy', 'creatorIndexUserAfterDestroy');

  LevelCredit.removeHook('afterSave', 'creatorIndexLevelCreditAfterSave');
  LevelCredit.removeHook('afterDestroy', 'creatorIndexLevelCreditAfterDestroy');
  LevelCredit.removeHook('afterBulkCreate', 'creatorIndexLevelCreditBulkCreate');
  LevelCredit.removeHook('afterBulkUpdate', 'creatorIndexLevelCreditBulkUpdate');
  LevelCredit.removeHook('afterBulkDestroy', 'creatorIndexLevelCreditBulkDestroy');

  // ========================= Creator =========================
  Creator.addHook('afterSave', 'creatorIndexAfterSave', async (creator: Creator, options: any) => {
    try {
      await runAfterCommit(options, async () => {
        await api.indexCreator(creator.id);
      });
    } catch (error) {
      logger.error(`Error in creator afterSave hook for creator ${creator.id}:`, error);
    }
  });

  Creator.addHook('afterCreate', 'creatorIndexAfterCreate', async (creator: Creator, options: any) => {
    try {
      await runAfterCommit(options, async () => {
        await api.indexCreator(creator.id);
      });
    } catch (error) {
      logger.error(`Error in creator afterCreate hook for creator ${creator.id}:`, error);
    }
  });

  Creator.addHook('afterDestroy', 'creatorIndexAfterDestroy', async (creator: Creator, options: any) => {
    try {
      await runAfterCommit(options, async () => {
        await api.deleteCreatorDocumentById(creator.id);
      });
    } catch (error) {
      logger.error(`Error in creator afterDestroy hook for creator ${creator.id}:`, error);
    }
  });

  Creator.addHook('afterBulkUpdate', 'creatorIndexBulkUpdate', async (options: any) => {
    try {
      const ids = extractNumericIdsFromSequelizeWhereField(options.where?.id);
      if (ids.length === 0) return;
      const run = async () => {
        await api.reindexCreators(ids);
      };
      if (options.transaction) {
        await options.transaction.afterCommit(run);
      } else {
        await run();
      }
    } catch (error) {
      logger.error('Error in creator afterBulkUpdate hook:', error);
    }
  });

  // ========================= CreatorAlias =========================
  const indexCreatorForAlias = async (alias: CreatorAlias, options: any) => {
    try {
      const creatorId = alias.creatorId;
      if (!creatorId) return;
      await runAfterCommit(options, async () => {
        await api.indexCreator(creatorId);
      });
    } catch (error) {
      logger.error(`Error resolving creatorId for CreatorAlias ${alias.id}:`, error);
    }
  };

  CreatorAlias.addHook('afterSave', 'creatorIndexAliasAfterSave', async (alias: CreatorAlias, options: any) => {
    await indexCreatorForAlias(alias, options);
  });

  CreatorAlias.addHook('afterDestroy', 'creatorIndexAliasAfterDestroy', async (alias: CreatorAlias, options: any) => {
    await indexCreatorForAlias(alias, options);
  });

  // ========================= User (creatorId link) =========================
  User.addHook('afterSave', 'creatorIndexUserAfterSave', async (user: User, options: any) => {
    try {
      // Reindex on any user save where a creatorId is currently linked or was just unlinked.
      // Sequelize's `previous('creatorId')` lets us catch both directions in a single hook.
      const previousCreatorIdRaw = (user as any).previous?.('creatorId');
      const previousCreatorId =
        typeof previousCreatorIdRaw === 'number' && Number.isFinite(previousCreatorIdRaw) && previousCreatorIdRaw > 0
          ? previousCreatorIdRaw
          : null;
      const currentCreatorId =
        typeof user.creatorId === 'number' && Number.isFinite(user.creatorId) && user.creatorId > 0
          ? user.creatorId
          : null;

      const ids = new Set<number>();
      if (previousCreatorId != null) ids.add(previousCreatorId);
      if (currentCreatorId != null) ids.add(currentCreatorId);
      if (ids.size === 0) return;

      await runAfterCommit(options, async () => {
        await api.reindexCreators([...ids]);
      });
    } catch (error) {
      logger.error(`Error in user afterSave creator-index hook for user ${user.id}:`, error);
    }
  });

  User.addHook('afterDestroy', 'creatorIndexUserAfterDestroy', async (user: User, options: any) => {
    try {
      const creatorId = user.creatorId;
      if (!creatorId) return;
      await runAfterCommit(options, async () => {
        await api.indexCreator(creatorId);
      });
    } catch (error) {
      logger.error(`Error in user afterDestroy creator-index hook for user ${user.id}:`, error);
    }
  });

  // ========================= LevelCredit =========================
  // Likes/clears live on the level row and update less frequently; we accept slight
  // staleness for now — the next credit edit (or the periodic full reindex on boot)
  // picks them up.
  // TODO: hook into the existing Level.afterSave path that already triggers level
  // reindex to also debounce-reindex the affected creators.
  LevelCredit.addHook('afterSave', 'creatorIndexLevelCreditAfterSave', async (credit: LevelCredit, options: any) => {
    try {
      const creatorId = credit.creatorId;
      if (!creatorId) return;
      await runAfterCommit(options, async () => {
        await api.reindexCreators([creatorId]);
      });
    } catch (error) {
      logger.error(`Error in level-credit afterSave creator-index hook for credit ${credit.id}:`, error);
    }
  });

  LevelCredit.addHook('afterDestroy', 'creatorIndexLevelCreditAfterDestroy', async (credit: LevelCredit, options: any) => {
    try {
      const creatorId = credit.creatorId;
      if (!creatorId) return;
      await runAfterCommit(options, async () => {
        await api.reindexCreators([creatorId]);
      });
    } catch (error) {
      logger.error(`Error in level-credit afterDestroy creator-index hook for credit ${credit.id}:`, error);
    }
  });

  LevelCredit.addHook('afterBulkCreate', 'creatorIndexLevelCreditBulkCreate', async (instances: LevelCredit[], options: any) => {
    try {
      const creatorIds = [...new Set(
        instances
          .map((c) => c.creatorId)
          .filter((id): id is number => typeof id === 'number' && Number.isFinite(id) && id > 0),
      )];
      if (creatorIds.length === 0) return;
      const run = async () => {
        await api.reindexCreators(creatorIds);
      };
      if (options.transaction) {
        await options.transaction.afterCommit(run);
      } else {
        await run();
      }
    } catch (error) {
      logger.error('Error in level-credit afterBulkCreate creator-index hook:', error);
    }
  });

  LevelCredit.addHook('afterBulkUpdate', 'creatorIndexLevelCreditBulkUpdate', async (options: any) => {
    try {
      const explicitIds = extractNumericIdsFromSequelizeWhereField(options.where?.creatorId);
      let creatorIds: number[] = explicitIds;
      if (creatorIds.length === 0 && options.where) {
        const credits = await LevelCredit.findAll({
          where: options.where,
          attributes: ['creatorId'],
          transaction: options.transaction,
        });
        creatorIds = [...new Set(credits.map((c) => c.creatorId))].filter(
          (id): id is number => typeof id === 'number' && Number.isFinite(id),
        );
      }
      if (creatorIds.length === 0) return;
      const run = async () => {
        await api.reindexCreators(creatorIds);
      };
      if (options.transaction) {
        await options.transaction.afterCommit(run);
      } else {
        await run();
      }
    } catch (error) {
      logger.error('Error in level-credit afterBulkUpdate creator-index hook:', error);
    }
  });

  LevelCredit.addHook('afterBulkDestroy', 'creatorIndexLevelCreditBulkDestroy', async (options: any) => {
    try {
      const explicitIds = extractNumericIdsFromSequelizeWhereField(options.where?.creatorId);
      let creatorIds: number[] = explicitIds;
      if (creatorIds.length === 0 && options.where) {
        // Fetch BEFORE the destroy completes — Sequelize's afterBulkDestroy fires after
        // the rows are gone, so the same `where` clause will return nothing. We accept
        // this and rely on `where.creatorId` being explicit, or otherwise no-op.
      }
      if (creatorIds.length === 0) return;
      const run = async () => {
        await api.reindexCreators(creatorIds);
      };
      if (options.transaction) {
        await options.transaction.afterCommit(run);
      } else {
        await run();
      }
    } catch (error) {
      logger.error('Error in level-credit afterBulkDestroy creator-index hook:', error);
    }
  });
}
