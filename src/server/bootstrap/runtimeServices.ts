import { logger } from '@/server/services/core/LoggerService.js';
import ElasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';
import { redis } from '@/server/services/core/RedisService.js';
import { registerShutdownStep } from '@/server/bootstrap/shutdownCoordinator.js';
import { sweepWorkspaceRootOnBoot } from '@/server/services/core/WorkspaceService.js';

/**
 * Starts background integrations/services that are not part of Express wiring.
 */
export async function initializeRuntimeServices(): Promise<void> {
  // Wipe any orphan workspace dirs left behind by a prior SIGKILL before anything else
  // starts writing to disk.
  await sweepWorkspaceRootOnBoot();

  try {
    logger.info('Connecting to Redis...');
    await redis.connect();
  } catch (error) {
    logger.error('Error connecting to Redis:', error);
    logger.warn('Application will continue without Redis caching');
  }

  registerShutdownStep({
    name: 'redis',
    priority: 90,
    fn: () => redis.disconnect(),
  });

  try {
    logger.info('Starting Async Elasticsearch initialization...');
    const elasticsearchService = ElasticsearchService.getInstance();
    // ElasticsearchService.initialize() internally detects mapping-hash drift for
    // the players index and only triggers reindexAllPlayers() when needed, so the
    // bootstrap never forces a full recomputation.
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    elasticsearchService.initialize();
  } catch (error) {
    logger.error('Error initializing Elasticsearch:', error);
    logger.warn('Application will continue without Elasticsearch functionality');
  }

  const { RefreshTokenCleanupService } = await import('@/server/services/accounts/RefreshTokenCleanupService.js');
  RefreshTokenCleanupService.getInstance();

  const { AccountDeletionCleanupService } = await import('@/server/services/accounts/AccountDeletionCleanupService.js');
  AccountDeletionCleanupService.getInstance();

  const { AuditLogService } = await import('@/server/services/core/AuditLogService.js');
  AuditLogService.startScheduledRetention();

  const { initUploadKinds } = await import('@/server/services/upload/registerKinds.js');
  initUploadKinds();
}

/**
 * @deprecated Shutdown now runs through the coordinator; each service registers its own step.
 * Kept for back-compat with {@link registerGlobalProcessHandlers}' optional `onShutdown`.
 */
export async function shutdownRuntimeServices(): Promise<void> {
  // Intentional no-op — Redis is registered as a coordinator step above.
}
