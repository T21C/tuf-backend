import { Request, Response, NextFunction } from 'express';
import { createHash } from 'crypto';
import { redis } from '@/server/services/core/RedisService.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { permissionFlags } from '@/config/constants.js';
import { hasFlag } from '@/misc/utils/auth/permissionUtils.js';
import { coalesceHttpCache, createInflightRegistry, INFLIGHT_CACHE_LIMIT } from './inflightWork.js';

/**
 * Configuration for cache behavior
 */
export interface CacheConfig {
  /** Time-to-live in seconds (default: 300 = 5 minutes) */
  ttl?: number;
  /** Custom cache key prefix (default: 'cache') */
  prefix?: string;
  /** Custom key generator function */
  superKeyGenerator?: (req: Request) => string;
  /** Vary cache by these query parameters (if not specified, uses all) */
  varyByQuery?: string[];
  /** Vary cache by user ID (requires auth middleware to run first) */
  varyByUser?: boolean;
  /** Vary cache by user role/permissions (groups users by role for better cache efficiency) */
  varyByRole?: boolean;
  /** Bypass cache for authenticated users */
  bypassForAuth?: boolean;
  /** Custom condition to skip caching */
  skipIf?: (req: Request) => boolean;
  /** Add cache headers to response */
  addHeaders?: boolean;
  /** Tags for cache invalidation - can be array or function that returns tags based on request */
  tags?: string[] | ((req: Request) => string[]);
}

const DEFAULT_CONFIG: Required<Omit<CacheConfig, 'superKeyGenerator' | 'varyByQuery' | 'skipIf' | 'tags'>> = {
  ttl: 300,
  prefix: 'cache',
  varyByUser: false,
  varyByRole: false,
  bypassForAuth: false,
  addHeaders: true,
};

/** Shared by the middleware and the decorator. Capped so a key leak cannot grow without bound. */
const httpCacheFlights = createInflightRegistry(INFLIGHT_CACHE_LIMIT);

function tagsForRequest(req: Request, config: CacheConfig): string[] {
  if (!config.tags) return [];
  return typeof config.tags === 'function' ? config.tags(req) : config.tags;
}

function attachCacheTags(cacheKey: string, tags: string[]): Promise<void> {
  if (tags.length === 0) return Promise.resolve();
  return Promise.all(
    tags.map((tag) => {
      const tagKey = `cache:tags:${tag}`;
      return redis.sAdd(tagKey, cacheKey).catch((err) => {
        logger.error(`Cache tag error for ${tagKey}:`, err);
      });
    }),
  ).then(() => undefined);
}

async function serveCachedGet(
  req: Request,
  res: Response,
  cacheKey: string,
  ttlSec: number,
  addHeaders: boolean,
  config: CacheConfig,
  proceed: () => unknown,
): Promise<unknown> {
  return coalesceHttpCache({
    registry: httpCacheFlights,
    cacheKey,
    ttlSec,
    addHeaders,
    res,
    read: () => redis.get(cacheKey),
    readTtl: () => redis.ttl(cacheKey),
    write: (payload) => redis.set(cacheKey, payload, ttlSec),
    registerTags: () => attachCacheTags(cacheKey, tagsForRequest(req, config)),
    proceed,
    onTimeout: () => {
      logger.warn(`Pending cache fill timed out for key: ${cacheKey}`);
    },
    onWriteError: (error) => {
      logger.error('Cache SET error:', error);
    },
    onTagError: (error) => {
      logger.error('Cache tagging error:', error);
    },
  });
}

/**
 * Determine user role/cache group based on permissions
 * Groups users into: 'admin', 'authenticated', 'anonymous'
 */
function getUserRoleGroup(req: Request): string {
  if (!req.user) {
    return 'anonymous';
  }

  // Super admins see deleted/hidden content, so they need separate cache
  if (hasFlag(req.user, permissionFlags.SUPER_ADMIN)) {
    return 'admin';
  }

  // All other authenticated users can share cache
  return 'authenticated';
}

/**
 * Generate a cache key from the request
 */
function generateCacheKey(req: Request, config: CacheConfig): string {
  const { prefix = 'cache', varyByQuery, varyByUser, varyByRole } = config;

  // If custom key generator is provided, use it
  if (config.superKeyGenerator) {
    return `${prefix}:${config.superKeyGenerator(req)}`;
  }

  // Build key parts
  const parts: string[] = [
    req.method,
    req.baseUrl + req.path,
  ];

  // Add query parameters
  if (varyByQuery) {
    // Only include specified query params
    const queryParts = varyByQuery
      .filter(key => req.query[key] !== undefined)
      .map(key => `${key}=${req.query[key]}`)
      .sort();
    if (queryParts.length > 0) {
      parts.push(queryParts.join('&'));
    }
  } else if (Object.keys(req.query).length > 0) {
    // Include all query params
    const sortedQuery = Object.keys(req.query)
      .sort()
      .map(key => `${key}=${req.query[key]}`)
      .join('&');
    parts.push(sortedQuery);
  }

  // Add user ID if varying by user (most specific)
  if (varyByUser && req.user?.id) {
    parts.push(`user:${req.user.id}`);
  } else if (varyByRole) {
    // Add role group if varying by role (groups users by permissions)
    parts.push(`role:${getUserRoleGroup(req)}`);
  }

  // Create a hash for the key to avoid super long keys
  const keyContent = parts.join(':');
  const hash = createHash('md5').update(keyContent).digest('hex');

  return `${prefix}:${req.baseUrl}${req.path}:${hash}`;
}

/**
 * Cache middleware factory
 *
 * @example
 * // Basic usage with defaults (5 min TTL)
 * router.get('/levels', Cache(), async (req, res) => { ... });
 *
 * @example
 * // Custom TTL
 * router.get('/stats', Cache({ ttl: 60 }), async (req, res) => { ... });
 *
 * @example
 * // Vary by specific query params only
 * router.get('/search', Cache({
 *   ttl: 120,
 *   varyByQuery: ['q', 'page', 'limit']
 * }), async (req, res) => { ... });
 *
 * @example
 * // Per-user caching
 * router.get('/my-data', Auth.user(), Cache({
 *   varyByUser: true,
 *   ttl: 60
 * }), async (req, res) => { ... });
 *
 * @example
 * // Role-based caching (groups users by permissions for better performance)
 * router.get('/levels/:id', Auth.addUserToRequest(), Cache({
 *   varyByRole: true,
 *   ttl: 300
 * }), async (req, res) => { ... });
 *
 * **Stacked responses:** when the JSON body is assembled from multiple backends (e.g. pack
 * tree from SQL + levels from Elasticsearch), `Cache()` is wrong — it only caches the final
 * body and returns before your handler runs. Skip route-level `Cache` for that route and use
 * {@link readCacheLayer}, {@link writeCacheLayer}, and {@link getOrFetchCacheLayer} from
 * `./stackedCacheLayers.js` inside the handler: peek layers, fetch misses, merge, `res.json`.
 */
export function Cache(config: CacheConfig = {}): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Only cache GET requests
    if (req.method !== 'GET') {
      next();
      return;
    }

    // Check skip conditions
    if (config.skipIf?.(req)) {
      next();
      return;
    }

    // Bypass for authenticated users if configured
    if (mergedConfig.bypassForAuth && req.user) {
      next();
      return;
    }

    const cacheKey = generateCacheKey(req, mergedConfig);

    let started = false;
    try {
      await serveCachedGet(req, res, cacheKey, mergedConfig.ttl, mergedConfig.addHeaders, config, () => {
        started = true;
        next();
      });
    } catch (error) {
      logger.error('Cache middleware error:', error);
      if (res.headersSent) return;
      if (!started) {
        next();
        return;
      }
      next(error);
    }
  };
}

/**
 * Decorator for caching controller method responses
 *
 * @example
 * class LevelController {
 *   @Cached({ ttl: 300, prefix: 'levels' })
 *   async getAll(req: Request, res: Response) {
 *     const levels = await Level.findAll();
 *     return res.json(levels);
 *   }
 * }
 */
export function Cached(config: CacheConfig = {}) {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };

  return function (
    target: unknown,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (req: Request, res: Response, ...args: unknown[]) {
      // Only cache GET requests
      if (req.method !== 'GET') {
        return originalMethod.apply(this, [req, res, ...args]);
      }

      // Check skip conditions
      if (config.skipIf?.(req)) {
        return originalMethod.apply(this, [req, res, ...args]);
      }

      // Bypass for authenticated users if configured
      if (mergedConfig.bypassForAuth && req.user) {
        return originalMethod.apply(this, [req, res, ...args]);
      }

      const cacheKey = generateCacheKey(req, mergedConfig);
      let started = false;
      try {
        return await serveCachedGet(
          req,
          res,
          cacheKey,
          mergedConfig.ttl,
          mergedConfig.addHeaders,
          config,
          () => {
            started = true;
            return originalMethod.apply(this, [req, res, ...args]);
          },
        );
      } catch (error) {
        logger.error('Cache decorator error:', error);
        if (!started && !res.headersSent) {
          return originalMethod.apply(this, [req, res, ...args]);
        }
        throw error;
      }
    };

    return descriptor;
  };
}

/**
 * Cache invalidation utilities
 */
export const CacheInvalidation = {
  /**
   * Invalidate a specific cache key
   */
  async invalidate(key: string): Promise<boolean> {
    return redis.del(key);
  },

  /**
   * Invalidate all keys matching a pattern
   * @example CacheInvalidation.invalidatePattern('cache:/api/levels/*')
   */
  async invalidatePattern(pattern: string): Promise<number> {
    return redis.delPattern(pattern);
  },

  /**
   * Invalidate all keys with a specific prefix
   * @example CacheInvalidation.invalidatePrefix('levels')
   */
  async invalidatePrefix(prefix: string): Promise<number> {
    return redis.delPattern(`${prefix}:*`);
  },

  /**
   * Invalidate all cache entries with a specific tag
   * @example CacheInvalidation.invalidateTag('pack:123')
   */
  async invalidateTag(tag: string): Promise<number> {
    try {
      const tagKey = `cache:tags:${tag}`;
      const cacheKeys = await redis.sMembers(tagKey);

      if (cacheKeys.length === 0) {
        return 0;
      }

      // Delete all cache keys
      const deleted = await Promise.all(
        cacheKeys.map(key => redis.del(key))
      );

      // Delete the tag set itself
      await redis.sDel(tagKey);

      const count = deleted.filter(Boolean).length;
      //logger.debug(`Cache invalidated: ${count} keys for tag ${tag}`);
      return count;
    } catch (error) {
      logger.error(`Cache invalidation error for tag ${tag}:`, error);
      return 0;
    }
  },

  /**
   * Invalidate multiple tags at once
   * @example CacheInvalidation.invalidateTags(['pack:123', 'pack:456'])
   */
  async invalidateTags(tags: string[]): Promise<number> {
    const results = await Promise.all(
      tags.map(tag => this.invalidateTag(tag))
    );
    return results.reduce((sum, count) => sum + count, 0);
  },

  /**
   * Invalidate all cache entries for a specific user by UUID
   * Only invalidates the UUID-specific tag to avoid affecting other users' caches
   * @example CacheInvalidation.invalidateUser('123e4567-e89b-12d3-a456-426614174000')
   */
  async invalidateUser(userId: string): Promise<number> {
    return this.invalidateTag(`user:${userId}`);
  },

  /**
   * Create middleware that invalidates cache after successful mutation
   * @example router.post('/levels', Auth.curator(), InvalidateCache('levels'), createLevel);
   */
  after(patterns: string | string[]): (req: Request, res: Response, next: NextFunction) => void {
    const patternList = Array.isArray(patterns) ? patterns : [patterns];

    return (req: Request, res: Response, next: NextFunction): void => {
      const originalJson = res.json.bind(res);

      res.json = function (body: unknown): Response {
        // Invalidate cache on successful mutations
        if (res.statusCode >= 200 && res.statusCode < 300) {
          Promise.all(patternList.map(p => redis.delPattern(`${p}:*`)))
            .then(results => {
              const total = results.reduce((a, b) => a + b, 0);
              if (total > 0) {
                //logger.debug(`Cache invalidated: ${total} keys for patterns [${patternList.join(', ')}]`);
              }
            })
            .catch(err => logger.error('Cache invalidation error:', err));
        }

        return originalJson(body);
      };

      next();
    };
  },
};

/**
 * Shorthand for common cache configurations
 */
export const CachePresets = {
  /** 1 minute cache - for frequently changing data */
  short: (overrides?: Partial<CacheConfig>) => Cache({ ttl: 60, ...overrides }),

  /** 5 minute cache - default, good for most endpoints */
  medium: (overrides?: Partial<CacheConfig>) => Cache({ ttl: 300, ...overrides }),

  /** 30 minute cache - for semi-static data */
  long: (overrides?: Partial<CacheConfig>) => Cache({ ttl: 1800, ...overrides }),

  /** 1 hour cache - for rarely changing data */
  extended: (overrides?: Partial<CacheConfig>) => Cache({ ttl: 3600, ...overrides }),

  /** Per-user cache with 5 minute TTL */
  perUser: (overrides?: Partial<CacheConfig>) => Cache({ ttl: 300, varyByUser: true, ...overrides }),

  /** Role-based cache with 5 minute TTL (groups users by permissions: admin, authenticated, anonymous) */
  byRole: (overrides?: Partial<CacheConfig>) => Cache({ ttl: 300, varyByRole: true, ...overrides }),

  /** No cache for authenticated users, 5 min for anonymous */
  publicOnly: (overrides?: Partial<CacheConfig>) => Cache({ ttl: 300, bypassForAuth: true, ...overrides }),
};

export {
  readCacheLayer,
  writeCacheLayer,
  getOrFetchCacheLayer,
  readCacheLayers,
  packLayerStorageKey,
  defaultPackLayerTags,
} from './stackedCacheLayers.js';
