import type {Transaction} from 'sequelize';
import {Op} from 'sequelize';
import Difficulty from '@/models/levels/Difficulty.js';
import Level from '@/models/levels/Level.js';
import Pass from '@/models/passes/Pass.js';
import {logger} from '@/server/services/core/LoggerService.js';
import {OutboxService} from '@/server/services/outbox/OutboxService.js';
import {OUTBOX_EVENT_TYPES, type LevelReratedPayload} from '@/server/services/outbox/events.js';
import {notificationService} from './NotificationService.js';
import {chartSnapshot} from './chartOwnerNotify.js';
import {NOTIFICATION_TYPES} from './types.js';

export function isTrackedRerate(previousDiffId: unknown, newDiffId: unknown): boolean {
  const previous = Number(previousDiffId);
  const next = Number(newDiffId);
  return (
    Number.isInteger(previous) &&
    Number.isInteger(next) &&
    previous > 0 &&
    next > 0 &&
    previous !== next
  );
}

async function difficultyNameById(
  ids: number[],
  transaction?: Transaction,
): Promise<Map<number, string | null>> {
  const unique = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
  const names = new Map<number, string | null>();
  if (!unique.length) return names;

  const rows = await Difficulty.findAll({
    attributes: ['id', 'name'],
    where: {id: {[Op.in]: unique}},
    transaction,
  });
  for (const row of rows) {
    const id = Number(row.id);
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    names.set(id, name || null);
  }
  return names;
}

function reratePayload(args: {
  snapshot: {levelId: number; song: string | null; artist: string | null};
  previousDifficultyName: string | null;
  difficultyName: string | null;
}) {
  return {
    ...args.snapshot,
    previousDifficultyName: args.previousDifficultyName,
    difficultyName: args.difficultyName,
  };
}

export async function notifyTrackedLevelRerate(args: {
  level: {id: number; song?: string | null; artist?: string | null};
  previousDiffId: number;
  newDiffId: number;
  rerateHistoryId: number;
  actorId?: string | null;
  transaction?: Transaction;
}): Promise<boolean> {
  if (!isTrackedRerate(args.previousDiffId, args.newDiffId)) return false;
  const rerateHistoryId = Number(args.rerateHistoryId);
  if (!Number.isInteger(rerateHistoryId) || rerateHistoryId <= 0) return false;

  const snapshot = chartSnapshot(args.level);
  if (!Number.isFinite(snapshot.levelId) || snapshot.levelId <= 0) return false;

  const names = await difficultyNameById([args.previousDiffId, args.newDiffId], args.transaction);
  const previousDifficultyName = names.get(Number(args.previousDiffId)) ?? null;
  const difficultyName = names.get(Number(args.newDiffId)) ?? null;
  const payload = reratePayload({snapshot, previousDifficultyName, difficultyName});

  await notificationService.notify({
    type: NOTIFICATION_TYPES.ChartRerated,
    payload,
    recipients: {levelId: snapshot.levelId},
    actorId: args.actorId ?? null,
    dedupKey: `chart.rerated:${rerateHistoryId}`,
    entity: {type: 'level', id: String(snapshot.levelId)},
    transaction: args.transaction,
  });

  await OutboxService.emit(OUTBOX_EVENT_TYPES.LevelRerated, {
    aggregate: 'level',
    aggregateId: String(snapshot.levelId),
    payload: {
      levelId: snapshot.levelId,
      rerateHistoryId,
      previousDiffId: Number(args.previousDiffId),
      newDiffId: Number(args.newDiffId),
      song: snapshot.song,
      artist: snapshot.artist,
      actorId: args.actorId ?? null,
    },
    dedupKey: `level-rerated:${rerateHistoryId}`,
    transaction: args.transaction,
  });

  return true;
}

export async function processLevelRerated(payload: LevelReratedPayload): Promise<void> {
  const levelId = Number(payload.levelId);
  const rerateHistoryId = Number(payload.rerateHistoryId);
  const previousDiffId = Number(payload.previousDiffId);
  const newDiffId = Number(payload.newDiffId);
  if (!Number.isInteger(levelId) || levelId <= 0) return;
  if (!Number.isInteger(rerateHistoryId) || rerateHistoryId <= 0) return;
  if (!isTrackedRerate(previousDiffId, newDiffId)) return;

  const [level, names, passRows] = await Promise.all([
    Level.findByPk(levelId, {attributes: ['id', 'song', 'artist']}),
    difficultyNameById([previousDiffId, newDiffId]),
    Pass.findAll({
      attributes: ['playerId'],
      where: {
        levelId,
        [Op.or]: [{isDeleted: false}, {isDeleted: null}],
      },
    }),
  ]);

  const playerIds = [
    ...new Set(
      passRows
        .map((row) => Number(row.playerId))
        .filter((id) => Number.isInteger(id) && id > 0),
    ),
  ];
  if (!playerIds.length) return;

  const snapshot = {
    levelId,
    song: level?.song ?? payload.song ?? null,
    artist: level?.artist ?? payload.artist ?? null,
  };

  await notificationService.notify({
    type: NOTIFICATION_TYPES.PassLevelRerated,
    payload: reratePayload({
      snapshot,
      previousDifficultyName: names.get(previousDiffId) ?? null,
      difficultyName: names.get(newDiffId) ?? null,
    }),
    recipients: {playerIds},
    actorId: payload.actorId ?? null,
    dedupKey: `pass.level.rerated:${rerateHistoryId}`,
    entity: {type: 'level', id: String(levelId)},
  });
}

export async function handleLevelRerated(payload: LevelReratedPayload): Promise<void> {
  try {
    await processLevelRerated(payload);
  } catch (error) {
    logger.error('[level-rerated] Fan-out failed', {
      levelId: payload.levelId,
      rerateHistoryId: payload.rerateHistoryId,
      error,
    });
    throw error;
  }
}
