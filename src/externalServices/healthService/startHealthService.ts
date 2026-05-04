import { setTerminalServiceTitle } from '@/misc/utils/terminalTitle.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { HealthService } from './HealthService.js';
import { HEALTH_CONFIG } from './config.js';

setTerminalServiceTitle('TUF Health');
logger.info(`[health] starting standalone health service on port ${HEALTH_CONFIG.port}`);

const healthService = HealthService.getInstance();
healthService.start().catch((error) => {
  logger.error('[health] failed to start', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});

async function shutdown(signal: string): Promise<void> {
  logger.info(`[health] received ${signal}, shutting down`);
  await healthService.stop();
  process.exit(0);
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
