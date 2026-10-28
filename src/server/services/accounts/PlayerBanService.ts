import {Op, Transaction} from 'sequelize';
import sequelize from '@/config/db.js';
import {permissionFlags} from '@/config/constants.js';
import {setUserPermissionAndSave} from '@/misc/utils/auth/permissionUtils.js';
import {safeTransactionRollback} from '@/misc/utils/Utility.js';
import {CacheInvalidation} from '@/server/middleware/cache.js';
import ElasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';
import {logger} from '@/server/services/core/LoggerService.js';
import Pass from '@/models/passes/Pass.js';
import Player from '@/models/players/Player.js';
import User from '@/models/auth/User.js';
import {PlayerBanError} from '@/server/services/accounts/playerBanUtils.js';

export {
  BAN_DURATION_MAX,
  BAN_DURATION_MIN,
  BAN_DURATION_UNITS,
  BAN_EXPIRY_UNITS,
  BAN_FOREVER_UNIT,
  computeBannedUntil,
  isAdminBanActive,
  isBanCurrentlyActive,
  isBannedUntilExpired,
  isForeverBanUnit,
  isPermissionBanActive,
  parseBanDuration,
  PlayerBanError,
  resolveBannedUntil,
} from '@/server/services/accounts/playerBanUtils.js';
export type {BanDurationInput, BanDurationUnit} from '@/server/services/accounts/playerBanUtils.js';

async function updateAffectedLevelsWorldsFirst(playerId: number, transaction?: Transaction) {
  const affectedLevels = await Pass.findAll({
    where: {
      playerId,
      isDeleted: false,
    },
    attributes: ['levelId'],
    group: ['levelId'],
    transaction,
  });

  const levelIds = new Set<number>();
  const wfLevels = await Pass.findAll({
    where: {playerId, isWorldsFirst: true},
    attributes: ['levelId'],
    group: ['levelId'],
    transaction,
  });
  const wfppLevels = await Pass.findAll({
    where: {playerId, isWorldsFirstPP: true},
    attributes: ['levelId'],
    group: ['levelId'],
    transaction,
  });
  for (const row of [...affectedLevels, ...wfLevels, ...wfppLevels]) {
    levelIds.add(row.levelId);
  }

  // Lazy import: passes/index also mounts search routes that construct PlayerStatsService
  // at module load. A static import here cycles through ModifierService on boot.
  const {updateWorldsFirstFlags} = await import('@/server/routes/v2/database/passes/index.js');
  for (const levelId of levelIds) {
    await updateWorldsFirstFlags(levelId, transaction);
  }
}

async function reindexBanSideEffects(playerId: number): Promise<void> {
  const elasticsearchService = ElasticsearchService.getInstance();
  await elasticsearchService.reindexPlayers([playerId]);
  try {
    const affectedPlayerIds = await Pass.findAll({
      attributes: ['playerId'],
      where: {
        levelId: {
          [Op.in]: (
            await Pass.findAll({
              attributes: ['levelId'],
              where: {playerId},
              raw: true,
            })
          )
            .map((p) => p.levelId)
            .filter(Boolean),
        },
        playerId: {[Op.ne]: playerId},
      },
      raw: true,
    });
    const otherIds = Array.from(
      new Set(affectedPlayerIds.map((p) => p.playerId).filter((x): x is number => !!x)),
    );
    if (otherIds.length > 0) {
      await elasticsearchService.reindexPlayers(otherIds);
    }
  } catch (err) {
    logger.warn('Failed to reindex players affected by ban worlds-first shift', err);
  }
}

export type SetPlayerBanStatusInput =
  | {isBanned: false}
  | {isBanned: true; bannedUntil: Date | null};

export type SetRerateRequestBanInput =
  | {banned: false}
  | {banned: true; bannedUntil: Date | null};

export async function setRerateRequestBanStatus(
  playerId: number,
  input: SetRerateRequestBanInput,
): Promise<Player> {
  let transaction: Transaction | undefined;
  try {
    transaction = await sequelize.transaction();
    const player = await Player.findByPk(playerId, {
      transaction,
      include: [
        {
          model: User,
          as: 'user',
          attributes: ['id', 'playerId', 'nickname', 'username', 'permissionFlags', 'permissionVersion'],
        },
      ],
    });
    if (!player) {
      throw new PlayerBanError(404, 'Player not found');
    }
    const bannedUntil = input.banned ? input.bannedUntil : null;
    await player.update({rerateRequestBannedUntil: bannedUntil}, {transaction});
    if (player.user) {
      await setUserPermissionAndSave(
        player.user,
        permissionFlags.RERATE_REQUEST_BANNED,
        input.banned,
        transaction,
      );
    }
    await transaction.commit();
    transaction = undefined;
    if (player.user) {
      await CacheInvalidation.invalidateUser(player.user.id);
    }
    return player;
  } catch (error) {
    await safeTransactionRollback(transaction);
    throw error;
  }
}

export async function setPlayerBanStatus(
  playerId: number,
  input: SetPlayerBanStatusInput,
): Promise<Player> {
  let transaction: Transaction | undefined;
  try {
    transaction = await sequelize.transaction();
    const player = await Player.findByPk(playerId, {
      transaction,
      include: [
        {
          model: User,
          as: 'user',
          attributes: [
            'id',
            'playerId',
            'nickname',
            'avatarUrl',
            'username',
            'permissionFlags',
            'permissionVersion',
          ],
        },
      ],
    });
    if (!player) {
      throw new PlayerBanError(404, 'Player not found');
    }

    const isBanned = input.isBanned;
    const bannedUntil = isBanned ? input.bannedUntil : null;

    await player.update({isBanned, bannedUntil}, {transaction});
    if (player.user) {
      await setUserPermissionAndSave(player.user, permissionFlags.BANNED, isBanned, transaction);
    }
    await updateAffectedLevelsWorldsFirst(player.id, transaction);
    await transaction.commit();
    transaction = undefined;

    if (player.user) {
      await CacheInvalidation.invalidateUser(player.user.id);
    }
    await reindexBanSideEffects(player.id);

    return player;
  } catch (error) {
    await safeTransactionRollback(transaction);
    throw error;
  }
}
