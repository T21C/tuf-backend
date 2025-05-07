import axios from 'axios';
import { checkMemoryUsage } from '../utils/memUtils.js';
import { logger } from '../services/LoggerService.js';

const BASE_URL = 'http://localhost:3002'; // Adjust this to your server URL
const CONCURRENT_REQUESTS = 10;
const TOTAL_REQUESTS = 1000;
const DELAY_BETWEEN_BATCHES = 1000; // 1 second

async function makeRequest(levelId: number) {
  try {
    const response = await axios.get(`${BASE_URL}/v2/media/thumbnail/level/${levelId}`, {
      responseType: 'arraybuffer',
      timeout: 30000
    });
    return response.status === 200;
  } catch (error) {
    logger.error(`Request failed for level ${levelId}:`, error instanceof Error ? error.message.slice(0, 100) : String(error).slice(0, 100));
    return false;
  }
}

async function runBatch(startId: number, count: number) {
  const promises = [];
  for (let i = 0; i < count; i++) {
    const levelId = startId + i;
    promises.push(makeRequest(levelId));
  }
  return Promise.all(promises);
}

async function stressTest() {
  logger.info('Starting Puppeteer stress test...');
  logger.info(`Configuration: ${CONCURRENT_REQUESTS} concurrent requests, ${TOTAL_REQUESTS} total requests`);
  
  let successCount = 0;
  let failureCount = 0;
  let currentId = 1;

  for (let i = 0; i < TOTAL_REQUESTS; i += CONCURRENT_REQUESTS) {
    const batchSize = Math.min(CONCURRENT_REQUESTS, TOTAL_REQUESTS - i);
    logger.info(`Running batch ${i / CONCURRENT_REQUESTS + 1} with ${batchSize} requests`);
    
    const results = await runBatch(currentId, batchSize);
    results.forEach(success => {
      if (success) successCount++;
      else failureCount++;
    });

    currentId += batchSize;
    
    // Log memory usage after each batch
    logger.info('Memory usage after batch:');
    checkMemoryUsage();
    
    // Wait before next batch
    await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES));
  }

  logger.info('Stress test completed');
  logger.info(`Results: ${successCount} successful, ${failureCount} failed`);
}

// Run the stress test
stressTest().catch(error => {
  logger.error('Stress test failed:', error instanceof Error ? error.message.slice(0, 100) : String(error).slice(0, 100));
  process.exit(1);
}); 