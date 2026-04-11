import { logger } from '@/server/services/LoggerService.js';
import ElasticsearchService from '@/server/services/ElasticsearchService.js';
import { PlayerStatsService } from '@/server/services/PlayerStatsService.js';
import { redis } from '@/server/services/RedisService.js';

/**
 * Starts background integrations/services that are not part of Express wiring.
 */
export async function initializeRuntimeServices(): Promise<void> {
  try {
    logger.info('Connecting to Redis...');
    await redis.connect();
  } catch (error) {
    logger.error('Error connecting to Redis:', error);
    logger.warn('Application will continue without Redis caching');
  }

  try {
    logger.info('Starting Async Elasticsearch initialization...');
    const elasticsearchService = ElasticsearchService.getInstance();
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    elasticsearchService.initialize();
  } catch (error) {
    logger.error('Error initializing Elasticsearch:', error);
    logger.warn('Application will continue without Elasticsearch functionality');
  }

  const playerStatsService = PlayerStatsService.getInstance();
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  playerStatsService.initialize();

  const { RefreshTokenCleanupService } = await import('@/server/services/RefreshTokenCleanupService.js');
  RefreshTokenCleanupService.getInstance();

  const { AccountDeletionCleanupService } = await import('@/server/services/AccountDeletionCleanupService.js');
  AccountDeletionCleanupService.getInstance();

  const { AuditLogService } = await import('@/server/services/AuditLogService.js');
  AuditLogService.startScheduledRetention();
}

export async function shutdownRuntimeServices(): Promise<void> {
  await redis.disconnect();
}
