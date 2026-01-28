import { Sequelize } from 'sequelize';
import dotenv from 'dotenv';
import { logger } from '../server/services/LoggerService.js';

dotenv.config();

export interface PoolConfig {
  name: string;
  maxConnections: number;
  minConnections?: number;
  acquireTimeout?: number;
  idleTimeout?: number;
}

export interface ModelPoolMapping {
  [modelGroup: string]: string; // Maps model group name to pool name
}

/**
 * PoolManager manages isolated connection pools for different model groups.
 * This prevents one bottleneck from exhausting all database connections.
 */
export class PoolManager {
  private pools: Map<string, Sequelize> = new Map();
  private modelMappings: ModelPoolMapping = {};
  private defaultPool: Sequelize;
  private readonly baseConfig = {
    dialect: 'mysql' as const,
    host: process.env.DB_HOST,
    username: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database:
      process.env.NODE_ENV === 'staging'
        ? process.env.DB_STAGING_DATABASE
        : process.env.DB_DATABASE,
    logging: false,
    dialectOptions: {
      connectTimeout: 60000,
      timezone: '+00:00', // Force UTC timezone
    },
    retry: {
      max: 3,
      backoffBase: 1000,
      backoffExponent: 1.5,
    },
  };

  constructor(defaultMaxConnections = 50) {
    // Create default pool (backward compatibility)
    this.defaultPool = this.createPool('default', {
      name: 'default',
      maxConnections: defaultMaxConnections,
      minConnections: 2,
      acquireTimeout: 60000,
      idleTimeout: 10000,
    });
  }

  /**
   * Creates a new isolated connection pool
   */
  createPool(poolName: string, config: PoolConfig): Sequelize {
    if (this.pools.has(poolName)) {
      logger.warn(`Pool ${poolName} already exists, returning existing pool`);
      return this.pools.get(poolName)!;
    }

    const sequelize = new Sequelize({
      ...this.baseConfig,
      pool: {
        max: config.maxConnections,
        min: config.minConnections ?? 2,
        acquire: config.acquireTimeout ?? 60000,
        idle: config.idleTimeout ?? 10000,
        validate: (connection: any) => {
          return connection.query('SELECT 1');
        },
        evict: 30000,
      },
    });

    this.pools.set(poolName, sequelize);
    logger.debug(`Created isolated pool '${poolName}' with max ${config.maxConnections} connections`);
    return sequelize;
  }

  /**
   * Assigns a model group to a specific pool
   */
  assignModelGroupToPool(modelGroup: string, poolName: string): void {
    if (!this.pools.has(poolName)) {
      throw new Error(`Pool '${poolName}' does not exist. Create it first using createPool().`);
    }
    this.modelMappings[modelGroup] = poolName;
    logger.debug(`Assigned model group '${modelGroup}' to pool '${poolName}'`);
  }

  /**
   * Gets the Sequelize instance for a specific model group
   * Falls back to default pool if no mapping exists
   */
  getPoolForModelGroup(modelGroup: string): Sequelize {
    const poolName = this.modelMappings[modelGroup];
    if (poolName && this.pools.has(poolName)) {
      return this.pools.get(poolName)!;
    }
    return this.defaultPool;
  }

  /**
   * Gets a specific pool by name
   */
  getPool(poolName: string): Sequelize {
    if (!this.pools.has(poolName)) {
      throw new Error(`Pool '${poolName}' does not exist`);
    }
    return this.pools.get(poolName)!;
  }

  /**
   * Gets the default pool (for backward compatibility)
   */
  getDefaultPool(): Sequelize {
    return this.defaultPool;
  }

  /**
   * Gets all pools for monitoring/management
   */
  getAllPools(): Map<string, Sequelize> {
    return new Map(this.pools);
  }

  /**
   * Gets pool statistics for all pools
   */
  async getPoolStats(): Promise<Record<string, any>> {
    const stats: Record<string, any> = {};

    for (const [poolName, sequelize] of this.pools.entries()) {
      try {
        // Access pool through connectionManager with type assertion
        const connectionManager = sequelize.connectionManager as any;
        const pool = connectionManager.pool;
        stats[poolName] = {
          size: pool?.size ?? 0,
          available: pool?.available ?? 0,
          using: pool?.using ?? 0,
          waiting: pool?.waiting ?? 0,
        };
      } catch (error) {
        logger.error(`Error getting stats for pool ${poolName}:`, error);
        stats[poolName] = { error: 'Failed to get stats' };
      }
    }

    return stats;
  }

  /**
   * Closes all pools gracefully
   */
  async closeAllPools(): Promise<void> {
    const closePromises = Array.from(this.pools.values()).map(async (sequelize) => {
      try {
        await sequelize.close();
      } catch (error) {
        logger.error('Error closing pool:', error);
      }
    });

    await Promise.all(closePromises);
    this.pools.clear();
    logger.info('All pools closed');
  }

  /**
   * Closes a specific pool
   */
  async closePool(poolName: string): Promise<void> {
    if (!this.pools.has(poolName)) {
      logger.warn(`Pool ${poolName} does not exist`);
      return;
    }

    const sequelize = this.pools.get(poolName)!;
    try {
      await sequelize.close();
      this.pools.delete(poolName);
      // Remove mappings that reference this pool
      Object.keys(this.modelMappings).forEach((group) => {
        if (this.modelMappings[group] === poolName) {
          delete this.modelMappings[group];
        }
      });
      logger.info(`Pool ${poolName} closed`);
    } catch (error) {
      logger.error(`Error closing pool ${poolName}:`, error);
    }
  }
}

// Singleton instance
let poolManagerInstance: PoolManager | null = null;

/**
 * Gets or creates the singleton PoolManager instance
 */
export function getPoolManager(): PoolManager {
  if (!poolManagerInstance) {
    poolManagerInstance = new PoolManager(50); // Default max 50 connections
  }
  return poolManagerInstance;
}

/**
 * Initialize pools based on configuration
 * Call this during application startup
 */
export function initializePools(config?: {
  pools?: PoolConfig[];
  modelMappings?: ModelPoolMapping;
}): PoolManager {
  const manager = getPoolManager();

  if (config?.pools) {
    let totalConnections = 0;
    for (const poolConfig of config.pools) {
      manager.createPool(poolConfig.name, poolConfig);
      totalConnections += poolConfig.maxConnections;
    }
    logger.info(`Initialized ${totalConnections} connections across ${config.pools.length} pools`);
  }

  if (config?.modelMappings) {
    for (const [modelGroup, poolName] of Object.entries(config.modelMappings)) {
      manager.assignModelGroupToPool(modelGroup, poolName);
    }
  }

  return manager;
}

