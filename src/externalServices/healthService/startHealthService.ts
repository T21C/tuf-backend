import { HealthService } from './HealthService.js';

// Inform users about running the health service independently
console.log('Starting health service in standalone mode...');
console.log('Health service will listen on port 3883 and monitor the main server.');

// Start the health service
const healthService = HealthService.getInstance();
healthService.start().catch(error => {
  console.error('Failed to start health service:', error);
  process.exit(1);
});

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down health service...');
  await healthService.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Shutting down health service...');
  await healthService.stop();
  process.exit(0);
});
