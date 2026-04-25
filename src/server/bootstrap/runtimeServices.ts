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

  if (redis.isConnected()) {
    const { startOutboxRelay, stopOutboxRelay } = await import('@/server/services/outbox/outboxRelay.js');
    const { startDiscordOutboxDispatcher } = await import('@/server/services/outbox/discordOutboxDispatcher.js');
    const { OutboxRetentionService } = await import('@/server/services/outbox/OutboxRetentionService.js');
    startOutboxRelay();
    startDiscordOutboxDispatcher();
    OutboxRetentionService.startScheduledRetention();
    registerShutdownStep({
      name: 'outbox-relay',
      priority: 44,
      fn: async () => {
        stopOutboxRelay();
      },
    });
  }

  try {
    logger.info('Starting Elasticsearch + CDC projectors...');
    const elasticsearchService = ElasticsearchService.getInstance();
    await elasticsearchService.initialize();
    const { startCdcProjectors } = await import('@/server/services/elasticsearch/projectors/startCdcProjectors.js');
    startCdcProjectors();
    const { ElasticsearchReconcileCronService } = await import(
      '@/server/services/elasticsearch/ElasticsearchReconcileCronService.js'
    );
    ElasticsearchReconcileCronService.startScheduledReconciliation();
  } catch (error) {
    logger.error('Error initializing Elasticsearch / CDC projectors:', error);
    logger.warn('Application will continue without Elasticsearch / CDC projector functionality');
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
