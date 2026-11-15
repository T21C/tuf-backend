import {Op} from 'sequelize';
import Difficulty from '@/models/levels/Difficulty.js';
import Level from '@/models/levels/Level.js';
import ReferenceWatch from '@/models/notifications/ReferenceWatch.js';
import {logger} from '@/server/services/core/LoggerService.js';
import {notificationService} from '@/server/services/notifications/NotificationService.js';
import {NOTIFICATION_TYPES} from '@/server/services/notifications/types.js';
import type {ReferenceChangedPayload} from '@/server/services/outbox/events.js';
import {joinDifficultyNames, referenceChangeDedupKey} from './referenceChange.js';

export async function processReferenceChanged(payload: ReferenceChangedPayload): Promise<void> {
  const levelId = Number(payload.levelId);
  if (!Number.isInteger(levelId) || levelId <= 0) return;

  const difficultyIds = [
    ...new Set(
      (payload.difficultyIds ?? []).filter((id) => Number.isInteger(id) && id > 0),
    ),
  ];
  if (!difficultyIds.length) return;

  const watches = await ReferenceWatch.findAll({
    attributes: ['userId', 'difficultyId'],
    where: {difficultyId: {[Op.in]: difficultyIds}},
  });
  if (!watches.length) return;

  const watchedByUser = new Map<string, Set<number>>();
  for (const row of watches) {
    const userId = row.userId;
    const difficultyId = Number(row.difficultyId);
    if (!userId || !Number.isInteger(difficultyId) || difficultyId <= 0) continue;
    const set = watchedByUser.get(userId) ?? new Set<number>();
    set.add(difficultyId);
    watchedByUser.set(userId, set);
  }
  if (!watchedByUser.size) return;

  const nameIds = [...difficultyIds];
  const previousDiffId = Number(payload.previousDiffId);
  if (Number.isInteger(previousDiffId) && previousDiffId > 0) nameIds.push(previousDiffId);

  const [level, difficulties] = await Promise.all([
    Level.findByPk(levelId, {attributes: ['id', 'song', 'artist']}),
    Difficulty.findAll({
      attributes: ['id', 'name', 'sortOrder'],
      where: {id: {[Op.in]: nameIds}},
    }),
  ]);

  const difficultyById = new Map(difficulties.map((row) => [Number(row.id), row]));
  const previousDifficultyName =
    Number.isInteger(previousDiffId) && previousDiffId > 0
      ? (difficultyById.get(previousDiffId)?.name ?? null)
      : null;

  const song = level?.song ?? null;
  const artist = level?.artist ?? null;
  const actorId = payload.actorId ?? null;
  const notifyDedupKey = referenceChangeDedupKey({
    kind: payload.kind,
    levelId,
    difficultyId: difficultyIds.length === 1 ? difficultyIds[0] : null,
    type: payload.type,
    fileId: payload.fileId,
    dlLink: payload.dlLink,
    diffId: payload.diffId,
    isHidden: payload.isHidden,
  });

  for (const [userId, watchedIds] of watchedByUser) {
    const names = difficulties
      .filter((row) => watchedIds.has(Number(row.id)))
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
      .map((row) => row.name)
      .filter(Boolean);
    if (!names.length) continue;

    try {
      await notificationService.notify({
        type: NOTIFICATION_TYPES.ReferenceChanged,
        payload: {
          kind: payload.kind,
          levelId,
          song,
          artist,
          difficultyNames: joinDifficultyNames(names),
          type: payload.type ?? null,
          previousType: payload.previousType ?? null,
          previousDifficultyName,
        },
        recipients: {userIds: [userId]},
        actorId,
        dedupKey: notifyDedupKey,
        entity: {type: 'level', id: String(levelId)},
      });
    } catch (error) {
      logger.error('[reference-changed] Fan-out failed', {userId, levelId, error});
      throw error;
    }
  }
}
