/**
 * Script to reindex all levels with normalized song/artist data
 * Run this after migrating existing level data to normalized structure
 * 
 * Usage: ts-node server/src/externalServices/scripts/reindexLevelsWithNormalizedData.ts
 */

import ElasticsearchService from '../../server/services/ElasticsearchService.js';
import { logger } from '../../server/services/LoggerService.js';

async function reindexAllLevels() {
  try {
    logger.info('Starting reindex of all levels with normalized song/artist data...');
    
    const elasticsearchService = ElasticsearchService.getInstance();
    
    // Initialize Elasticsearch service
    await elasticsearchService.initialize();
    
    // Reindex all levels (this will use the updated parseFields method)
    await elasticsearchService.reindexLevels();
    
    logger.info('Reindex completed successfully!');
    process.exit(0);
  } catch (error) {
    logger.error('Error during reindex:', error);
    process.exit(1);
  }
}

// Run the script
reindexAllLevels();
