import { createClient, RedisClientType } from 'redis';
import { logger } from './LoggerService.js';

/**
 * Redis Service - Singleton for managing Redis connection
 */
class RedisService {
  private static instance: RedisService;
  private client: RedisClientType | null = null;
  private isConnecting: boolean = false;
  private connectionPromise: Promise<void> | null = null;

  private constructor() {}

  /**
   * Get singleton instance
   */
  public static getInstance(): RedisService {
    if (!RedisService.instance) {
      RedisService.instance = new RedisService();
    }
    return RedisService.instance;
  }

  /**
   * Initialize Redis connection
   */
  public async connect(): Promise<void> {
    if (this.client?.isReady) {
      return;
    }

    if (this.isConnecting && this.connectionPromise) {
      return this.connectionPromise;
    }

    this.isConnecting = true;

    this.connectionPromise = (async () => {
      try {
        const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

        this.client = createClient({
          url: redisUrl,
          socket: {
            reconnectStrategy: (retries) => {
              if (retries > 10) {
                logger.error('Redis: Max reconnection attempts reached');
                return new Error('Max reconnection attempts reached');
              }
              const delay = Math.min(retries * 100, 3000);
              logger.debug(`Redis: Reconnecting in ${delay}ms (attempt ${retries})`);
              return delay;
            },
          },
        });

        this.client.on('error', (err) => {
          logger.error('Redis client error:', err);
        });

        this.client.on('connect', () => {
          logger.info('Redis: Connected successfully');
        });

        this.client.on('reconnecting', () => {
          logger.debug('Redis: Reconnecting...');
        });

        this.client.on('end', () => {
          logger.info('Redis: Connection closed');
        });

        await this.client.connect();
      } catch (error) {
        logger.error('Redis: Failed to connect:', error);
        this.client = null;
        throw error;
      } finally {
        this.isConnecting = false;
      }
    })();

    return this.connectionPromise;
  }

  /**
   * Get the Redis client (ensures connection)
   */
  public async getClient(): Promise<RedisClientType | null> {
    if (!this.client?.isReady) {
      try {
        await this.connect();
      } catch {
        return null;
      }
    }
    return this.client;
  }

  /**
   * Check if Redis is connected
   */
  public isConnected(): boolean {
    return this.client?.isReady ?? false;
  }

  /**
   * Get cached value
   */
  public async get<T>(key: string): Promise<T | null> {
    try {
      const client = await this.getClient();
      if (!client) return null;

      const data = await client.get(key);
      if (!data) return null;

      return JSON.parse(data) as T;
    } catch (error) {
      logger.error(`Redis GET error for key ${key}:`, error);
      return null;
    }
  }

  /**
   * Set cached value with optional TTL (in seconds)
   */
  public async set(key: string, value: unknown, ttlSeconds?: number): Promise<boolean> {
    try {
      const client = await this.getClient();
      if (!client) return false;

      const serialized = JSON.stringify(value);

      if (ttlSeconds) {
        await client.setEx(key, ttlSeconds, serialized);
      } else {
        await client.set(key, serialized);
      }

      return true;
    } catch (error) {
      logger.error(`Redis SET error for key ${key}:`, error);
      return false;
    }
  }

  /**
   * Delete a cached key
   */
  public async del(key: string): Promise<boolean> {
    try {
      const client = await this.getClient();
      if (!client) return false;

      await client.del(key);
      return true;
    } catch (error) {
      logger.error(`Redis DEL error for key ${key}:`, error);
      return false;
    }
  }

  /**
   * Delete multiple keys matching a pattern
   */
  public async delPattern(pattern: string): Promise<number> {
    try {
      const client = await this.getClient();
      if (!client) return 0;

      const keys = await client.keys(pattern);
      if (keys.length === 0) return 0;

      const deleted = await client.del(keys);
      logger.debug(`Redis: Deleted ${deleted} keys matching pattern ${pattern}`);
      return deleted;
    } catch (error) {
      logger.error(`Redis DEL pattern error for ${pattern}:`, error);
      return 0;
    }
  }

  /**
   * Check if a key exists
   */
  public async exists(key: string): Promise<boolean> {
    try {
      const client = await this.getClient();
      if (!client) return false;

      return (await client.exists(key)) === 1;
    } catch (error) {
      logger.error(`Redis EXISTS error for key ${key}:`, error);
      return false;
    }
  }

  /**
   * Get TTL for a key (in seconds)
   */
  public async ttl(key: string): Promise<number> {
    try {
      const client = await this.getClient();
      if (!client) return -2;

      return await client.ttl(key);
    } catch (error) {
      logger.error(`Redis TTL error for key ${key}:`, error);
      return -2;
    }
  }

  /**
   * Flush all cache (use with caution)
   */
  public async flushAll(): Promise<boolean> {
    try {
      const client = await this.getClient();
      if (!client) return false;

      await client.flushAll();
      logger.info('Redis: Cache flushed');
      return true;
    } catch (error) {
      logger.error('Redis FLUSHALL error:', error);
      return false;
    }
  }

  /**
   * Add member to a set
   */
  public async sAdd(key: string, ...members: string[]): Promise<number> {
    try {
      const client = await this.getClient();
      if (!client) return 0;

      return await client.sAdd(key, members);
    } catch (error) {
      logger.error(`Redis SADD error for key ${key}:`, error);
      return 0;
    }
  }

  /**
   * Get all members of a set
   */
  public async sMembers(key: string): Promise<string[]> {
    try {
      const client = await this.getClient();
      if (!client) return [];

      return await client.sMembers(key);
    } catch (error) {
      logger.error(`Redis SMEMBERS error for key ${key}:`, error);
      return [];
    }
  }

  /**
   * Remove member(s) from a set
   */
  public async sRem(key: string, ...members: string[]): Promise<number> {
    try {
      const client = await this.getClient();
      if (!client) return 0;

      return await client.sRem(key, members);
    } catch (error) {
      logger.error(`Redis SREM error for key ${key}:`, error);
      return 0;
    }
  }

  /**
   * Get set size
   */
  public async sCard(key: string): Promise<number> {
    try {
      const client = await this.getClient();
      if (!client) return 0;

      return await client.sCard(key);
    } catch (error) {
      logger.error(`Redis SCARD error for key ${key}:`, error);
      return 0;
    }
  }

  /**
   * Delete a set
   */
  public async sDel(key: string): Promise<boolean> {
    try {
      const client = await this.getClient();
      if (!client) return false;

      await client.del(key);
      return true;
    } catch (error) {
      logger.error(`Redis SDEL error for key ${key}:`, error);
      return false;
    }
  }

  /**
   * Gracefully disconnect
   */
  public async disconnect(): Promise<void> {
    try {
      if (this.client) {
        await this.client.quit();
        this.client = null;
        logger.info('Redis: Disconnected gracefully');
      }
    } catch (error) {
      logger.error('Redis disconnect error:', error);
    }
  }
}

// Export singleton instance
export const redis = RedisService.getInstance();
export { RedisService };
