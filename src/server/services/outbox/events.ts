/**
 * Central registry of outbox event types and JSON payloads.
 * Add new types here first, then add a Discord (or other) handler.
 */

import type { LevelChartStats } from '@/misc/utils/data/chartCacheParse.js';

export type DiscordLevelChartStatsSnapshot = LevelChartStats;

export type DiscordLevelPreviousSource = 'cdn' | 'google_drive' | 'external';

export type DiscordLevelZipChartFile = {
  name: string;
  relativePath: string;
};

export type DiscordLevelZipAudioFile = {
  name: string;
};

export type DiscordLevelZipFilesSnapshot = {
  charts: DiscordLevelZipChartFile[];
  audio: DiscordLevelZipAudioFile[];
  targetRelativePath: string | null;
};

export type DiscordLevelFileSnapshot = {
  newFileId: string;
  zipFilename: string;
  zipSizeBytes: number;
  uploadSource: string;
  files: DiscordLevelZipFilesSnapshot;
  newChartStats: DiscordLevelChartStatsSnapshot;
};

export type DiscordLevelFileUpdatedPayload = DiscordLevelFileSnapshot & {
  originalPath: string;
  newPath: string;
  levelId: number;
  previousSource: DiscordLevelPreviousSource;
  oldChartStats: DiscordLevelChartStatsSnapshot;
  user: { username: string; avatarUrl: string | null; playerId: number | null };
};

export type DiscordLevelFileDeletedPayload = {
  levelId: number;
  user: { username: string; avatarUrl: string | null; playerId: number | null };
};

export type DiscordLevelFileUploadedPayload = DiscordLevelFileSnapshot & {
  filePath: string;
  levelId: number;
  user: { username: string; avatarUrl: string | null; playerId: number | null };
};

export type DiscordLevelTargetUpdatedPayload = {
  target: string;
  levelId: number;
  user: { username: string; avatarUrl: string | null; playerId: number | null };
};

export type LevelMetadataSnapshot = {
  song: string | null;
  artist: string | null;
  songId: number | null;
  suffix: string | null;
  videoLink: string | null;
  dlLink: string | null;
  workshopLink: string | null;
};

export type DiscordLevelMetadataChangedPayload = {
  levelId: number;
  difficultyIcon: string | null;
  oldMetadata: LevelMetadataSnapshot;
  newMetadata: LevelMetadataSnapshot;
  user: { username: string; avatarUrl: string | null; playerId: number | null };
};

export type DiscordPassBatchAnnouncementPayload = {
  passIds: number[];
};

export type DiscordLevelBatchAnnouncementPayload = {
  queueRowIds: number[];
};

export type DiscordRerateBatchAnnouncementPayload = {
  queueRowIds: number[];
};

export type NotificationCreatedPayload = {
  notificationId: number;
  userId: string;
  type: string;
};

export type FollowFanoutPayload = {
  kind: 'pass' | 'level';
  ids: number[];
};

export type DiscordTufStellarNomineePayload = {
  userId: string;
  username: string;
  avatarUrl: string | null;
  playerId: number | null;
  monthKey: string;
  officialRatingsThisMonth: number;
};

export const OUTBOX_EVENT_TYPES = {
  DiscordLevelFileUpdated: 'DiscordLevelFileUpdated',
  DiscordLevelFileDeleted: 'DiscordLevelFileDeleted',
  DiscordLevelFileUploaded: 'DiscordLevelFileUploaded',
  DiscordLevelTargetUpdated: 'DiscordLevelTargetUpdated',
  DiscordLevelMetadataChanged: 'DiscordLevelMetadataChanged',
  DiscordPassBatchAnnouncement: 'DiscordPassBatchAnnouncement',
  DiscordLevelBatchAnnouncement: 'DiscordLevelBatchAnnouncement',
  DiscordRerateBatchAnnouncement: 'DiscordRerateBatchAnnouncement',
  DiscordTufStellarNominee: 'DiscordTufStellarNominee',
  NotificationCreated: 'NotificationCreated',
  FollowFanout: 'FollowFanout',
} as const;

export type OutboxEventType = (typeof OUTBOX_EVENT_TYPES)[keyof typeof OUTBOX_EVENT_TYPES];

export type OutboxPayloadByType = {
  [OUTBOX_EVENT_TYPES.DiscordLevelFileUpdated]: DiscordLevelFileUpdatedPayload;
  [OUTBOX_EVENT_TYPES.DiscordLevelFileDeleted]: DiscordLevelFileDeletedPayload;
  [OUTBOX_EVENT_TYPES.DiscordLevelFileUploaded]: DiscordLevelFileUploadedPayload;
  [OUTBOX_EVENT_TYPES.DiscordLevelTargetUpdated]: DiscordLevelTargetUpdatedPayload;
  [OUTBOX_EVENT_TYPES.DiscordLevelMetadataChanged]: DiscordLevelMetadataChangedPayload;
  [OUTBOX_EVENT_TYPES.DiscordPassBatchAnnouncement]: DiscordPassBatchAnnouncementPayload;
  [OUTBOX_EVENT_TYPES.DiscordLevelBatchAnnouncement]: DiscordLevelBatchAnnouncementPayload;
  [OUTBOX_EVENT_TYPES.DiscordRerateBatchAnnouncement]: DiscordRerateBatchAnnouncementPayload;
  [OUTBOX_EVENT_TYPES.DiscordTufStellarNominee]: DiscordTufStellarNomineePayload;
  [OUTBOX_EVENT_TYPES.NotificationCreated]: NotificationCreatedPayload;
  [OUTBOX_EVENT_TYPES.FollowFanout]: FollowFanoutPayload;
};
