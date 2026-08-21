import type {Transaction} from 'sequelize';
import {notificationService} from './NotificationService.js';
import {NOTIFICATION_TYPES} from './types.js';

export function chartSnapshot(level: {
  id?: number;
  song?: string | null;
  artist?: string | null;
}): {levelId: number; song: string | null; artist: string | null} {
  return {
    levelId: Number(level.id),
    song: level.song ?? null,
    artist: level.artist ?? null,
  };
}

export async function notifyChartOwners(args: {
  type:
    | typeof NOTIFICATION_TYPES.ChartDeleted
    | typeof NOTIFICATION_TYPES.ChartRestored
    | typeof NOTIFICATION_TYPES.ChartModified
    | typeof NOTIFICATION_TYPES.ChartCurated
    | typeof NOTIFICATION_TYPES.ChartCurationRemoved;
  level: {id: number; song?: string | null; artist?: string | null};
  actorId?: string | null;
  reason?: string | null;
  dedupKey: string;
  transaction?: Transaction;
}): Promise<void> {
  const snapshot = chartSnapshot(args.level);
  if (!Number.isFinite(snapshot.levelId) || snapshot.levelId <= 0) return;

  await notificationService.notify({
    type: args.type,
    payload: {...snapshot, reason: args.reason ?? null},
    recipients: {levelId: snapshot.levelId},
    actorId: args.actorId ?? null,
    dedupKey: args.dedupKey,
    entity: {type: 'level', id: String(snapshot.levelId)},
    transaction: args.transaction,
  });
}

export async function notifyChartVisibilityChanged(args: {
  level: {id: number; song?: string | null; artist?: string | null};
  isHidden: boolean;
  actorId?: string | null;
  reason?: string | null;
  transaction: Transaction;
}): Promise<void> {
  const snapshot = chartSnapshot(args.level);
  if (!Number.isFinite(snapshot.levelId) || snapshot.levelId <= 0) return;

  await notificationService.notify({
    type: NOTIFICATION_TYPES.ChartVisibilityChanged,
    payload: {...snapshot, isHidden: args.isHidden, reason: args.reason ?? null},
    recipients: {levelId: snapshot.levelId},
    actorId: args.actorId ?? null,
    dedupKey: `chart-visibility:${snapshot.levelId}:${args.isHidden ? 'hidden' : 'public'}`,
    entity: {type: 'level', id: String(snapshot.levelId)},
    transaction: args.transaction,
  });
}

export async function notifyChartWeeklySelected(args: {
  level: {id: number; song?: string | null; artist?: string | null};
  weekStart: string;
  actorId?: string | null;
  transaction?: Transaction;
}): Promise<void> {
  const snapshot = chartSnapshot(args.level);
  if (!Number.isFinite(snapshot.levelId) || snapshot.levelId <= 0) return;

  await notificationService.notify({
    type: NOTIFICATION_TYPES.ChartWeeklySelected,
    payload: {...snapshot, weekStart: args.weekStart},
    recipients: {levelId: snapshot.levelId},
    actorId: args.actorId ?? null,
    dedupKey: `chart-weekly:${snapshot.levelId}:${args.weekStart}`,
    entity: {type: 'level', id: String(snapshot.levelId)},
    transaction: args.transaction,
  });
}
