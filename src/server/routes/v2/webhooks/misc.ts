import type { Transaction } from 'sequelize';
import Level from '@/models/levels/Level.js';
import type { User } from '@/models/index.js';
import { OutboxService } from '@/server/services/outbox/OutboxService.js';
import { OUTBOX_EVENT_TYPES } from '@/server/services/outbox/events.js';
import type { LevelMetadataSnapshot } from '@/server/services/outbox/events.js';

function outboxUserSnapshot(user: User) {
  return {
    username: user.username,
    avatarUrl: user.avatarUrl ?? null,
    playerId: user.playerId ?? null,
  };
}

function getLevelMetadata(level: Level): LevelMetadataSnapshot {
  return {
    song: level.song || null,
    artist: level.artist || null,
    songId: level.songId || null,
    suffix: level.suffix || null,
    videoLink: level.videoLink || null,
    dlLink: level.dlLink || null,
    workshopLink: level.workshopLink || null,
  };
}

async function logLevelFileUpdateHook(
  originalPath: string,
  newPath: string,
  levelId: number,
  user: User,
  transaction?: Transaction,
): Promise<void> {
  await OutboxService.emit(OUTBOX_EVENT_TYPES.DiscordLevelFileUpdated, {
    aggregate: 'level',
    aggregateId: String(levelId),
    payload: {
      originalPath,
      newPath,
      levelId,
      user: outboxUserSnapshot(user),
    },
    transaction,
  });
}

async function logLevelFileDeleteHook(
  levelId: number,
  user: User,
  transaction?: Transaction,
): Promise<void> {
  await OutboxService.emit(OUTBOX_EVENT_TYPES.DiscordLevelFileDeleted, {
    aggregate: 'level',
    aggregateId: String(levelId),
    payload: {
      levelId,
      user: outboxUserSnapshot(user),
    },
    transaction,
  });
}

async function logLevelFileUploadHook(
  filePath: string,
  levelId: number,
  user: User,
  transaction?: Transaction,
): Promise<void> {
  await OutboxService.emit(OUTBOX_EVENT_TYPES.DiscordLevelFileUploaded, {
    aggregate: 'level',
    aggregateId: String(levelId),
    payload: {
      filePath,
      levelId,
      user: outboxUserSnapshot(user),
    },
    transaction,
  });
}

async function logLevelTargetUpdateHook(
  target: string,
  levelId: number,
  user: User,
  transaction?: Transaction,
): Promise<void> {
  await OutboxService.emit(OUTBOX_EVENT_TYPES.DiscordLevelTargetUpdated, {
    aggregate: 'level',
    aggregateId: String(levelId),
    payload: {
      target,
      levelId,
      user: outboxUserSnapshot(user),
    },
    transaction,
  });
}

async function logLevelMetadataUpdateHook(
  oldLevel: Level,
  newLevel: Level,
  user: User,
  transaction?: Transaction,
): Promise<void> {
  const oldMetadata = getLevelMetadata(oldLevel);
  const newMetadata = getLevelMetadata(newLevel);

  let hasChanges = false;
  const keys = ['song', 'artist', 'songId', 'suffix', 'videoLink', 'dlLink', 'workshopLink'] as const;
  for (const key of keys) {
    if (oldMetadata[key] !== newMetadata[key]) {
      hasChanges = true;
      break;
    }
  }

  if (!hasChanges) return;

  await OutboxService.emit(OUTBOX_EVENT_TYPES.DiscordLevelMetadataChanged, {
    aggregate: 'level',
    aggregateId: String(newLevel.id),
    payload: {
      levelId: newLevel.id,
      difficultyIcon: newLevel.difficulty?.icon || null,
      oldMetadata,
      newMetadata,
      user: outboxUserSnapshot(user),
    },
    transaction,
  });
}

export { logLevelFileUpdateHook, logLevelFileDeleteHook, logLevelFileUploadHook, logLevelTargetUpdateHook, logLevelMetadataUpdateHook };
