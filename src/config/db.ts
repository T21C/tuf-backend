import {Sequelize} from 'sequelize';
import dotenv from 'dotenv';
import { getPoolManager, initializePools, PoolManager } from './PoolManager.js';

dotenv.config();

// Initialize PoolManager and get default pool (backward compatibility)
const poolManager = getPoolManager();
const sequelize = poolManager.getDefaultPool();

/**
 * @param modelGroup - The model group name (e.g., 'levels', 'auth', 'submissions')
 * @returns Sequelize instance for the model group (falls back to default if not mapped)
 */
export const getSequelizeForModelGroup = (modelGroup: string): Sequelize => {
  const sequelize = poolManager.getPoolForModelGroup(modelGroup);
  
  // Verify logging models get the correct database (synchronous check)
  if (modelGroup === 'logging') {
    const databaseName = (sequelize as any).config?.database;
    const expectedDatabase = process.env.DB_LOGGING_DATABASE || 'tuf_logging';
    if (databaseName !== expectedDatabase) {
      // Use console.error as fallback since logger might not be initialized yet
      console.error(`[CRITICAL] Model group 'logging' is using wrong database! Expected: ${expectedDatabase}, Got: ${databaseName}. Make sure pools are initialized before models.`);
      // Try to use logger if available
      try {
        const { logger } = require('../server/services/LoggerService.js');
        logger.error(`Model group 'logging' is using wrong database! Expected: ${expectedDatabase}, Got: ${databaseName}. Make sure pools are initialized before models.`);
      } catch {
        // Logger not available yet, console.error already called
      }
    }
  }
  
  return sequelize;
};

export const getPoolManagerInstance = (): PoolManager => {
  return poolManager;
};

/**
 * Initialize pools with configuration.
 * Call this during application startup before models are initialized.
 *
 * @example
 * initializeDatabasePools({
 *   pools: [
 *     { name: 'levels', maxConnections: 15 },
 *     { name: 'submissions', maxConnections: 10 },
 *     { name: 'auth', maxConnections: 5 }
 *   ],
 *   modelMappings: {
 *     'levels': 'levels',
 *     'submissions': 'submissions',
 *     'auth': 'auth'
 *   }
 * });
 */
export const initializeDatabasePools = (config?: {
  pools?: Array<{
    name: string;
    maxConnections: number;
    minConnections?: number;
    acquireTimeout?: number;
    idleTimeout?: number;
    evict?: number;
    database?: string;
  }>;
  modelMappings?: Record<string, string>;
}): void => {
  initializePools(config);
};

export default sequelize;
