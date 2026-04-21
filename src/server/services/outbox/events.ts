/**
 * Central registry of outbox event types and JSON payloads.
 * Add new types here first, then add a Discord (or other) handler.
 */

export type DiscordLevelFileUpdatedPayload = {
  originalPath: string;
  newPath: string;
  levelId: number;
  user: { username: string; avatarUrl: string | null; playerId: number | null };
};

export type DiscordLevelFileDeletedPayload = {
  levelId: number;
  user: { username: string; avatarUrl: string | null; playerId: number | null };
};

export type DiscordLevelFileUploadedPayload = {
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
  levelIds: number[];
};

export type DiscordRerateBatchAnnouncementPayload = {
  levelIds: number[];
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
};
