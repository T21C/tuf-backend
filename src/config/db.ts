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
  return poolManager.getPoolForModelGroup(modelGroup);
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
