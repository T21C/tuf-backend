import Player from '@/models/players/Player.js';
import User from '@/models/auth/User.js';
import OAuthProvider from '@/models/auth/OAuthProvider.js';
import Pass from '@/models/passes/Pass.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { extractNumericIdsFromSequelizeWhereField } from '@/server/services/elasticsearch/misc/extractNumericIdsFromSequelizeWhereField.js';

export interface PlayerIndexHookApi {
  indexPlayer(playerId: number): Promise<void>;
  reindexPlayers(playerIds: number[]): Promise<void>;
  deletePlayerDocumentById(playerId: number): Promise<void>;
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

export function registerPlayerIndexChangeListeners(api: PlayerIndexHookApi): void {
  // Remove any existing hooks with the same names (support hot reload).
  Player.removeHook('afterSave', 'playerIndexAfterSave');
  Player.removeHook('afterCreate', 'playerIndexAfterCreate');
  Player.removeHook('afterDestroy', 'playerIndexAfterDestroy');
  Player.removeHook('afterBulkUpdate', 'playerIndexBulkUpdate');

  User.removeHook('afterSave', 'playerIndexUserAfterSave');
  User.removeHook('afterDestroy', 'playerIndexUserAfterDestroy');
  User.removeHook('afterBulkUpdate', 'playerIndexUserBulkUpdate');

  OAuthProvider.removeHook('afterSave', 'playerIndexOauthAfterSave');
  OAuthProvider.removeHook('afterDestroy', 'playerIndexOauthAfterDestroy');

  Pass.removeHook('afterSave', 'playerIndexPassAfterSave');
  Pass.removeHook('afterDestroy', 'playerIndexPassAfterDestroy');
  Pass.removeHook('afterBulkUpdate', 'playerIndexPassBulkUpdate');
  Pass.removeHook('afterBulkCreate', 'playerIndexPassBulkCreate');

  // ========================= Player =========================
  Player.addHook('afterSave', 'playerIndexAfterSave', async (player: Player, options: any) => {
    try {
      await runAfterCommit(options, async () => {
        await api.indexPlayer(player.id);
      });
    } catch (error) {
      logger.error(`Error in player afterSave hook for player ${player.id}:`, error);
    }
  });

  Player.addHook('afterCreate', 'playerIndexAfterCreate', async (player: Player, options: any) => {
    try {
      await runAfterCommit(options, async () => {
        await api.indexPlayer(player.id);
      });
    } catch (error) {
      logger.error(`Error in player afterCreate hook for player ${player.id}:`, error);
    }
  });

  Player.addHook('afterDestroy', 'playerIndexAfterDestroy', async (player: Player, options: any) => {
    try {
      await runAfterCommit(options, async () => {
        await api.deletePlayerDocumentById(player.id);
      });
    } catch (error) {
      logger.error(`Error in player afterDestroy hook for player ${player.id}:`, error);
    }
  });

  Player.addHook('afterBulkUpdate', 'playerIndexBulkUpdate', async (options: any) => {
    try {
      const ids = extractNumericIdsFromSequelizeWhereField(options.where?.id);
      if (ids.length === 0) return;
      const run = async () => {
        await api.reindexPlayers(ids);
      };
      if (options.transaction) {
        await options.transaction.afterCommit(run);
      } else {
        await run();
      }
    } catch (error) {
      logger.error('Error in player afterBulkUpdate hook:', error);
    }
  });

  // ========================= User =========================
  User.addHook('afterSave', 'playerIndexUserAfterSave', async (user: User, options: any) => {
    try {
      const playerId = user.playerId;
      if (!playerId) return;
      await runAfterCommit(options, async () => {
        await api.indexPlayer(playerId);
      });
    } catch (error) {
      logger.error(`Error in user afterSave hook for user ${user.id}:`, error);
    }
  });

  User.addHook('afterDestroy', 'playerIndexUserAfterDestroy', async (user: User, options: any) => {
    try {
      const playerId = user.playerId;
      if (!playerId) return;
      await runAfterCommit(options, async () => {
        await api.indexPlayer(playerId);
      });
    } catch (error) {
      logger.error(`Error in user afterDestroy hook for user ${user.id}:`, error);
    }
  });

  User.addHook('afterBulkUpdate', 'playerIndexUserBulkUpdate', async (options: any) => {
    try {
      if (!options.where) return;
      // Only re-fetch affected playerIds if necessary (rare path).
      const users = await User.findAll({
        where: options.where,
        attributes: ['playerId'],
        transaction: options.transaction,
      });
      const playerIds = users
        .map((u) => u.playerId)
        .filter((id): id is number => typeof id === 'number' && Number.isFinite(id));
      if (playerIds.length === 0) return;
      const run = async () => {
        await api.reindexPlayers(playerIds);
      };
      if (options.transaction) {
        await options.transaction.afterCommit(run);
      } else {
        await run();
      }
    } catch (error) {
      logger.error('Error in user afterBulkUpdate hook:', error);
    }
  });

  // ========================= OAuthProvider (discord) =========================
  const indexPlayerForOAuthProvider = async (provider: OAuthProvider, options: any) => {
    try {
      if (provider.provider !== 'discord') return;
      const user = await User.findByPk(provider.userId, {
        attributes: ['playerId'],
        transaction: options.transaction,
      });
      const playerId = user?.playerId;
      if (!playerId) return;
      await runAfterCommit(options, async () => {
        await api.indexPlayer(playerId);
      });
    } catch (error) {
      logger.error(`Error resolving playerId for OAuthProvider ${provider.id}:`, error);
    }
  };

  OAuthProvider.addHook('afterSave', 'playerIndexOauthAfterSave', async (provider: OAuthProvider, options: any) => {
    await indexPlayerForOAuthProvider(provider, options);
  });

  OAuthProvider.addHook('afterDestroy', 'playerIndexOauthAfterDestroy', async (provider: OAuthProvider, options: any) => {
    await indexPlayerForOAuthProvider(provider, options);
  });

  // ========================= Pass =========================
  Pass.addHook('afterSave', 'playerIndexPassAfterSave', async (pass: Pass, options: any) => {
    try {
      const playerId = pass.playerId;
      if (!playerId) return;
      await runAfterCommit(options, async () => {
        await api.reindexPlayers([playerId]);
      });
    } catch (error) {
      logger.error(`Error in pass afterSave player-index hook for pass ${pass.id}:`, error);
    }
  });

  Pass.addHook('afterDestroy', 'playerIndexPassAfterDestroy', async (pass: Pass, options: any) => {
    try {
      const playerId = pass.playerId;
      if (!playerId) return;
      await runAfterCommit(options, async () => {
        await api.reindexPlayers([playerId]);
      });
    } catch (error) {
      logger.error(`Error in pass afterDestroy player-index hook for pass ${pass.id}:`, error);
    }
  });

  Pass.addHook('afterBulkUpdate', 'playerIndexPassBulkUpdate', async (options: any) => {
    try {
      const explicitIds = extractNumericIdsFromSequelizeWhereField(options.where?.playerId);
      let playerIds: number[] = explicitIds;
      if (playerIds.length === 0 && options.where) {
        const passes = await Pass.findAll({
          where: options.where,
          attributes: ['playerId'],
          transaction: options.transaction,
        });
        playerIds = [...new Set(passes.map((p) => p.playerId))].filter(
          (id): id is number => typeof id === 'number' && Number.isFinite(id),
        );
      }
      if (playerIds.length === 0) return;
      const run = async () => {
        await api.reindexPlayers(playerIds);
      };
      if (options.transaction) {
        await options.transaction.afterCommit(run);
      } else {
        await run();
      }
    } catch (error) {
      logger.error('Error in pass afterBulkUpdate player-index hook:', error);
    }
  });

  Pass.addHook('afterBulkCreate', 'playerIndexPassBulkCreate', async (instances: Pass[], options: any) => {
    try {
      const playerIds = [...new Set(
        instances
          .map((p) => p.playerId)
          .filter((id): id is number => typeof id === 'number' && Number.isFinite(id) && id > 0),
      )];
      if (playerIds.length === 0) return;
      const run = async () => {
        await api.reindexPlayers(playerIds);
      };
      if (options.transaction) {
        await options.transaction.afterCommit(run);
      } else {
        await run();
      }
    } catch (error) {
      logger.error('Error in pass afterBulkCreate player-index hook:', error);
    }
  });
}
