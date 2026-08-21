import Pass from '@/models/passes/Pass.js';
import Level from '@/models/levels/Level.js';
import Player from '@/models/players/Player.js';
import Difficulty from '@/models/levels/Difficulty.js';
import LevelCredit from '@/models/levels/LevelCredit.js';
import Creator from '@/models/credits/Creator.js';
import {logger} from '@/server/services/core/LoggerService.js';
import {notificationService} from '@/server/services/notifications/NotificationService.js';
import {listFollowerUserIds} from '@/server/services/notifications/FollowService.js';
import {NOTIFICATION_TYPES} from '@/server/services/notifications/types.js';
import type {FollowFanoutPayload} from '@/server/services/outbox/events.js';

function isUnrankedDifficulty(name?: string | null): boolean {
  return (name ?? '').trim().toLowerCase() === 'unranked';
}

async function fanoutPass(passId: number): Promise<void> {
  const pass = await Pass.findByPk(passId, {
    include: [
      {model: Player, as: 'player', attributes: ['id', 'name', 'isBanned']},
      {
        model: Level,
        as: 'level',
        attributes: ['id', 'song', 'artist', 'isHidden', 'isDeleted'],
        include: [{model: Difficulty, as: 'difficulty', attributes: ['name']}],
      },
    ],
  });
  if (!pass) return;
  if (pass.isHidden || pass.isDeleted) return;
  const player = pass.player;
  if (!player || player.isBanned) return;
  const level = pass.level;
  if (!level || level.isHidden || level.isDeleted) return;
  if (isUnrankedDifficulty(level.difficulty?.name)) return;

  const playerId = Number(pass.playerId ?? player.id);
  if (!Number.isInteger(playerId) || playerId <= 0) return;

  const userIds = await listFollowerUserIds('player', [playerId]);
  if (!userIds.length) return;

  await notificationService.notify({
    type: NOTIFICATION_TYPES.FollowingPlayerPass,
    payload: {
      passId: Number(pass.id),
      levelId: Number(level.id),
      song: level.song ?? null,
      artist: level.artist ?? null,
      playerId,
      playerName: player.name ?? null,
    },
    recipients: {userIds},
    skipActor: false,
    dedupKey: `following.player.pass:${pass.id}`,
    entity: {type: 'pass', id: String(pass.id)},
  });
}

async function fanoutLevel(levelId: number): Promise<void> {
  const level = await Level.findByPk(levelId, {
    attributes: ['id', 'song', 'artist', 'isHidden', 'isDeleted'],
    include: [
      {
        model: LevelCredit,
        as: 'levelCredits',
        attributes: ['creatorId', 'sortOrder'],
        include: [{model: Creator, as: 'creator', attributes: ['id', 'name']}],
      },
    ],
  });
  if (!level || level.isHidden || level.isDeleted) return;

  const credits = [...(level.levelCredits ?? [])].sort(
    (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0),
  );
  const creatorIds = [
    ...new Set(
      credits
        .map((credit) => Number(credit.creatorId ?? credit.creator?.id))
        .filter((id) => Number.isInteger(id) && id > 0),
    ),
  ];
  if (!creatorIds.length) return;

  const userIds = await listFollowerUserIds('creator', creatorIds);
  if (!userIds.length) return;

  const primary = credits.find((credit) => credit.creator)?.creator ?? null;
  const creatorId = Number(primary?.id ?? creatorIds[0]);
  const creatorName = primary?.name ?? null;

  await notificationService.notify({
    type: NOTIFICATION_TYPES.FollowingCreatorLevel,
    payload: {
      levelId: Number(level.id),
      song: level.song ?? null,
      artist: level.artist ?? null,
      creatorId,
      creatorName,
    },
    recipients: {userIds},
    skipActor: false,
    dedupKey: `following.creator.level:${level.id}`,
    entity: {type: 'level', id: String(level.id)},
  });
}

export async function processFollowFanout(payload: FollowFanoutPayload): Promise<void> {
  const ids = [...new Set((payload.ids ?? []).filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) return;

  if (payload.kind === 'pass') {
    for (const passId of ids) {
      try {
        await fanoutPass(passId);
      } catch (error) {
        logger.error('[follow-fanout] Pass fan-out failed', {passId, error});
        throw error;
      }
    }
    return;
  }

  if (payload.kind === 'level') {
    for (const levelId of ids) {
      try {
        await fanoutLevel(levelId);
      } catch (error) {
        logger.error('[follow-fanout] Level fan-out failed', {levelId, error});
        throw error;
      }
    }
  }
}

export async function emitFollowFanout(kind: 'pass' | 'level', ids: number[]): Promise<void> {
  const unique = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
  if (!unique.length) return;

  const {OutboxService} = await import('@/server/services/outbox/OutboxService.js');
  const {OUTBOX_EVENT_TYPES} = await import('@/server/services/outbox/events.js');

  for (const id of unique) {
    await OutboxService.emit(OUTBOX_EVENT_TYPES.FollowFanout, {
      aggregate: kind,
      aggregateId: String(id),
      payload: {kind, ids: [id]},
      dedupKey: `follow-fanout:${kind}:${id}`,
    });
  }
}
