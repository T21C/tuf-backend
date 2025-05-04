import { HealthService } from './HealthService.js';
import { logger } from '../services/LoggerService.js';

// Inform users about running the health service independently
logger.info('Starting health service in standalone mode...');
logger.info('Health service will listen on port 3883 and monitor the main server.');

// Start the health service
const healthService = HealthService.getInstance();
healthService.start().catch(error => {
  logger.error('Failed to start health service:', error);
  process.exit(1);
});

// Handle graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Shutting down health service...');
  await healthService.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Shutting down health service...');
  await healthService.stop();
  process.exit(0);
});
