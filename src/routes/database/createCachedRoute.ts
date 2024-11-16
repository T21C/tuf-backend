import { Request, Response, Router } from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import { Model, FilterQuery } from 'mongoose';

interface CacheEntry {
  timestamp: number;
  data: any;
}

interface PaginationParams {
  offset?: number;
  limit?: number;
  sort?: string;
}

interface CachedRouteOptions<T> {
  model: Model<T>;
  cachePrefix: string;
  cacheTTL?: number;
  buildQuery: (req: Request) => FilterQuery<T>;
  getSortOptions?: (req: Request) => Record<string, 'asc' | 'desc'>;
}

const CACHE_DIR = './cache';
const DEFAULT_TTL = 200 * 1000; // 200 seconds

// Cache helper functions
const getCachePath = (key: string) => path.join(CACHE_DIR, `${key}.json`);

const saveCache = async (key: string, data: any) => {
  const cacheEntry: CacheEntry = { timestamp: Date.now(), data };
  await fs.writeFile(getCachePath(key), JSON.stringify(cacheEntry), 'utf-8');
};

const getCache = async (key: string, ttl: number): Promise<any | null> => {
  try {
    const data = await fs.readFile(getCachePath(key), 'utf-8');
    const cache: CacheEntry = JSON.parse(data);
    
    if (Date.now() - cache.timestamp > ttl) {
      await fs.unlink(getCachePath(key)).catch(() => {});
      return null;
    }
    
    return cache.data;
  } catch (error) {
    return null;
  }
};

const timeOperation = async (name: string, operation: () => Promise<any>) => {
  const start = performance.now();
  const result = await operation();
  const duration = performance.now() - start;
  console.log(`[PERF] ${name}: ${duration.toFixed(2)}ms`);
  return result;
};

export function createCachedRoute<T>(options: CachedRouteOptions<T>): Router {
  const router = Router();
  const ttl = options.cacheTTL ?? DEFAULT_TTL;

  // List endpoint
  router.get('/', async (req: Request, res: Response) => {
    try {
      const routeStart = performance.now();
      const cacheKey = `${options.cachePrefix}_${JSON.stringify(req.query)}`.replace(/[^a-zA-Z0-9]/g, '_');
      
      const cachedResult = await getCache(cacheKey, ttl);
      if (cachedResult) {
        console.log(`[PERF] Cache hit: ${performance.now() - routeStart}ms`);
        return res.json(cachedResult);
      }

      const query = options.model.find(options.buildQuery(req));
      
      // Handle sorting
      if (options.getSortOptions) {
        query.sort(options.getSortOptions(req));
      }

      // Handle pagination
      const { offset, limit } = req.query as PaginationParams;
      if (offset) query.skip(Number(offset));
      if (limit) query.limit(Number(limit));

      const [results, count] = await timeOperation('Query execution', () =>
        Promise.all([
          query.exec(),
          options.model.countDocuments(query.getQuery())
        ])
      );

      const response = { count, results };
      await saveCache(cacheKey, response);

      const totalTime = performance.now() - routeStart;
      console.log(`[PERF] Total route time: ${totalTime.toFixed(2)}ms`);

      return res.json(response);
    } catch (error) {
      console.error(`Error fetching ${options.cachePrefix}:`, error);
      return res.status(500).json({ 
        error: `Failed to fetch ${options.cachePrefix}`,
        details: error instanceof Error ? error.message : String(error)
      });
    }
  });

  // Get by ID endpoint
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const routeStart = performance.now();
      const cacheKey = `${options.cachePrefix}_${req.params.id}`;
      
      const cachedItem = await getCache(cacheKey, ttl);
      if (cachedItem) {
        console.log(`[PERF] Single item cache hit: ${performance.now() - routeStart}ms`);
        return res.json(cachedItem);
      }

      const item = await timeOperation('Single item lookup', () =>
        options.model.findOne({ 
          _id: req.params.id,
          ...options.buildQuery(req)
        })
      );

      if (!item) {
        return res.status(404).json({ error: 'Item not found' });
      }

      await saveCache(cacheKey, item);
      
      const totalTime = performance.now() - routeStart;
      console.log(`[PERF] Total single item time: ${totalTime.toFixed(2)}ms`);

      return res.json(item);
    } catch (error) {
      console.error(`Error fetching ${options.cachePrefix}:`, error);
      return res.status(500).json({ 
        error: `Failed to fetch ${options.cachePrefix}`,
        details: error instanceof Error ? error.message : String(error)
      });
    }
  });

  return router;
}

// Create cache directory if it doesn't exist
fs.mkdir(CACHE_DIR).catch(() => {}); 