import {Sequelize} from 'sequelize';
import dotenv from 'dotenv';
import { getPoolManager, PoolManager } from './PoolManager.js';
import './poolDiagnostics.js';

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

export default sequelize;
