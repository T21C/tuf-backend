import { logger } from '@/server/services/core/LoggerService.js';
import ElasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';
import { PlayerStatsService } from '@/server/services/core/PlayerStatsService.js';
import { redis } from '@/server/services/core/RedisService.js';

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
    await elasticsearchService.initialize();
  } catch (error) {
    logger.error('Error initializing Elasticsearch:', error);
    logger.warn('Application will continue without Elasticsearch functionality');
  }

  const playerStatsService = PlayerStatsService.getInstance();
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  playerStatsService.initialize();

  const { RefreshTokenCleanupService } = await import('@/server/services/accounts/RefreshTokenCleanupService.js');
  RefreshTokenCleanupService.getInstance();

  const { AccountDeletionCleanupService } = await import('@/server/services/accounts/AccountDeletionCleanupService.js');
  AccountDeletionCleanupService.getInstance();

  const { AuditLogService } = await import('@/server/services/core/AuditLogService.js');
  AuditLogService.startScheduledRetention();
}

export async function shutdownRuntimeServices(): Promise<void> {
  await redis.disconnect();
}
