import { Request, Response, Router } from 'express';
import { escapeRegExp } from '../../../misc/Utility';
import { PATHS } from '../../../config/constants';
import { readJsonFile } from '../../../utils/fileHandlers';

const playersCache = readJsonFile(PATHS.playersJson);

// Helper function to apply query conditions
const applyQueryConditions = (player: any, query: any) => {
  if (query.query) {
    const queryRegex = new RegExp(escapeRegExp(query.query), 'i');
    return queryRegex.test(player.name);
  }
  return true;
};

const router: Router = Router();

router.get('/', async (req: Request, res: Response) => {
  try {
    const routeStart = performance.now();

    // Filter players based on query conditions
    let results = playersCache.filter((player: any) => applyQueryConditions(player, req.query));
    const count = results.length;

    // Handle pagination
    const offset = req.query.offset ? Number(req.query.offset) : 0;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    
    if (limit !== undefined) {
      results = results.slice(offset, offset + limit);
    }

    const totalTime = performance.now() - routeStart;
    console.log(`[PERF] Total route time: ${totalTime.toFixed(2)}ms`);

    return res.json({ count, results });
  } catch (error) {
    console.error('Error fetching players:', error);
    return res.status(500).json({ 
      error: 'Failed to fetch players',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

export default router;
