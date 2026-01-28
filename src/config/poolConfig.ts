import { initializeDatabasePools } from './db.js';

/**
 * Pool configuration for isolating model groups.
 *
 * This configuration allows you to:
 * 1. Create isolated connection pools for different model groups
 * 2. Prevent one bottleneck from exhausting all database connections
 * 3. Scale pools independently based on usage patterns
 *
 * To add a new pool:
 * 1. Add a pool config to the pools array
 * 2. Map your model group to the pool in modelMappings
 * 3. Update your model files to use getSequelizeForModelGroup()
 *
 * Pool sizing guidelines:
 * - High-traffic groups (levels, submissions): 10-15 connections
 * - Medium-traffic groups (players, passes): 5-10 connections
 * - Low-traffic groups (auth, admin): 3-5 connections
 * - Default pool: Remaining connections for unmapped models
 */

export interface PoolConfiguration {
  pools: Array<{
    name: string;
    maxConnections: number;
    minConnections?: number;
    acquireTimeout?: number;
    idleTimeout?: number;
    evict?: number;
  }>;
  modelMappings: Record<string, string>;
}

/**
 * Default pool configuration.
 * Modify this to suit your needs.
 */
const defaultPoolConfig: PoolConfiguration = {
  pools: [
    // High-traffic pools
    {
      name: 'levels',
      maxConnections: 10,
      minConnections: 2,
      acquireTimeout: 20000,
      idleTimeout: 10000,
      evict: 5000,
    },
    {
      name: 'players',
      maxConnections: 20,
      minConnections: 1,
      acquireTimeout: 20000,
      idleTimeout: 10000,
    },
    {
      name: 'passes',
      maxConnections: 20,
      minConnections: 2,
      acquireTimeout: 20000,
      idleTimeout: 10000,
      evict: 5000,
    },
    {
      name: 'auth',
      maxConnections: 10,
      minConnections: 1,
      acquireTimeout: 20000,
      idleTimeout: 10000,
      evict: 5000,
    },
    {
      name: 'admin',
      maxConnections: 10,
      minConnections: 1,
      acquireTimeout: 20000,
      idleTimeout: 10000,
      evict: 5000,
    },
    {
      name: 'curations',
      maxConnections: 20,
      minConnections: 1,
      acquireTimeout: 20000,
      idleTimeout: 10000,
      evict: 5000,
    },
    {
      name: 'packs',
      maxConnections: 5,
      minConnections: 1,
      acquireTimeout: 20000,
      idleTimeout: 10000,
      evict: 5000,
    },
    {
      name: 'credits',
      maxConnections: 10,
      minConnections: 1,
      acquireTimeout: 20000,
      idleTimeout: 10000,
      evict: 5000,
    },
    {
      name: 'announcements',
      maxConnections: 10,
      minConnections: 1,
      acquireTimeout: 20000,
      idleTimeout: 10000,
      evict: 5000,
    },
    {
      name: 'submissions',
      maxConnections: 10,
      minConnections: 1,
      acquireTimeout: 20000,
      idleTimeout: 10000,
      evict: 5000,
    },
    {
      name: 'cdn',
      maxConnections: 100,
      minConnections: 1,
      acquireTimeout: 20000,
      idleTimeout: 10000,
      evict: 5000,
    },
  ],
  modelMappings: {
    levels: 'levels',
    submissions: 'submissions',
    players: 'players',
    passes: 'passes',
    auth: 'auth',
    admin: 'admin',
    curations: 'curations',
    packs: 'packs',
    credits: 'credits',
    announcements: 'announcements',
    cdn: 'cdn',
  },
};

/**
 * Initialize pools with the default configuration.
 * Call this during application startup, before models are initialized.
 */
export function initializeDefaultPools(): void {
  initializeDatabasePools(defaultPoolConfig);
}

/**
 * Initialize pools with a custom configuration.
 * Use this if you want to override the default configuration.
 */
export function initializeCustomPools(config: PoolConfiguration): void {
  initializeDatabasePools(config);
}

/**
 * Get the default pool configuration.
 * Useful for extending or modifying the configuration.
 */
export function getDefaultPoolConfig(): PoolConfiguration {
  return defaultPoolConfig;
}

