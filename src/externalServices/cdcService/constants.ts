/**
 * Physical MySQL table names watched by the CDC tailer and consumed by projectors.
 * Must match Sequelize `tableName` values.
 */
export const CDC_WATCHED_TABLES: readonly string[] = [
  'passes',
  'levels',
  'level_likes',
  'players',
  'level_tags',
  'level_tag_assignments',
  'curations',
  'curation_curation_types',
  'songs',
  'song_aliases',
  'song_credits',
  'artists',
  'artist_aliases',
  'users',
  'user_oauth_providers',
  'ratings',
  'level_credits',
  'level_aliases',
  'creators',
  'creator_aliases',
] as const;

export const CDC_CHECKPOINT_REDIS_KEY = 'cdc:binlog_checkpoint';

/** When set (see cdcRestoreCoordination), binlog tailer skips XADD but still advances checkpoint. */
export const CDC_INGEST_PAUSED_KEY = 'cdc:ingest_paused';

export const CDC_STREAM_PREFIX = 'cdc:';
