import type {Transaction} from 'sequelize';
import {Op} from 'sequelize';
import User from '@/models/auth/User.js';
import LevelCredit from '@/models/levels/LevelCredit.js';
import ChartClearNotificationMute from '@/models/notifications/ChartClearNotificationMute.js';
import {notificationService} from './NotificationService.js';
import {NOTIFICATION_TYPES} from './types.js';
import {
  CHART_CLEARED_CREDIT_ROLES,
  isCharterOrVfxerCredit,
  resolveRecipientUserIds,
} from './recipients.js';
import {chartSnapshot} from './chartOwnerNotify.js';

export async function userIsCharterOrVfxerOnLevel(
  levelId: number,
  creatorId: number | null | undefined,
  transaction?: Transaction,
): Promise<boolean> {
  if (!Number.isFinite(creatorId) || !creatorId || creatorId <= 0) return false;
  const credits = await LevelCredit.findAll({
    attributes: ['role'],
    where: {levelId, creatorId},
    transaction,
  });
  return credits.some((credit) => isCharterOrVfxerCredit(credit.role));
}

export async function getChartClearMuteState(
  userId: string,
  creatorId: number | null | undefined,
  levelId: number,
): Promise<{credited: boolean; muted: boolean}> {
  const credited = await userIsCharterOrVfxerOnLevel(levelId, creatorId);
  if (!credited) return {credited: false, muted: false};
  const mute = await ChartClearNotificationMute.findOne({where: {userId, levelId}});
  return {credited: true, muted: Boolean(mute)};
}

export async function setChartClearMuted(
  userId: string,
  creatorId: number | null | undefined,
  levelId: number,
  muted: boolean,
): Promise<{credited: true; muted: boolean} | {error: 'not_credited'}> {
  const credited = await userIsCharterOrVfxerOnLevel(levelId, creatorId);
  if (!credited) return {error: 'not_credited'};
  if (muted) {
    await ChartClearNotificationMute.findOrCreate({
      where: {userId, levelId},
      defaults: {userId, levelId},
    });
  } else {
    await ChartClearNotificationMute.destroy({where: {userId, levelId}});
  }
  return {credited: true, muted};
}

export async function notifyChartCleared(args: {
  level: {id: number; song?: string | null; artist?: string | null};
  passId: number;
  playerId: number;
  playerName: string | null;
  transaction: Transaction;
}): Promise<void> {
  const snapshot = chartSnapshot(args.level);
  const passId = Number(args.passId);
  const playerId = Number(args.playerId);
  if (!Number.isFinite(snapshot.levelId) || snapshot.levelId <= 0) return;
  if (!Number.isFinite(passId) || passId <= 0) return;
  if (!Number.isFinite(playerId) || playerId <= 0) return;

  const userIds = await resolveRecipientUserIds(
    {
      levelId: snapshot.levelId,
      levelCreditRoles: [...CHART_CLEARED_CREDIT_ROLES],
    },
    args.transaction,
  );
  if (!userIds.length) return;

  const mutedRows = await ChartClearNotificationMute.findAll({
    attributes: ['userId'],
    where: {levelId: snapshot.levelId, userId: {[Op.in]: userIds}},
    transaction: args.transaction,
  });
  const muted = new Set(mutedRows.map((row) => row.userId));
  const recipients = userIds.filter((userId) => !muted.has(userId));
  if (!recipients.length) return;

  const clearer = await User.findOne({
    attributes: ['id'],
    where: {playerId},
    transaction: args.transaction,
  });

  await notificationService.notify({
    type: NOTIFICATION_TYPES.ChartCleared,
    payload: {
      passId,
      levelId: snapshot.levelId,
      song: snapshot.song,
      artist: snapshot.artist,
      playerId,
      playerName: args.playerName,
    },
    recipients: {userIds: recipients},
    actorId: clearer?.id ?? null,
    skipActor: true,
    dedupKey: `chart.cleared:${passId}`,
    entity: {type: 'pass', id: String(passId)},
    transaction: args.transaction,
  });
}
