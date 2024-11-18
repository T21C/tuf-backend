import { Request, Response, Router } from 'express';
import { escapeRegExp } from '../../../misc/Utility';
import { PATHS } from '../../../config/constants';
import { readJsonFile } from '../../../utils/fileHandlers';

const passesCache = readJsonFile(PATHS.passesJson);

// Helper function for sorting
const getSortOptions = (sort?: string) => {
  switch (sort) {
    case 'SCORE_ASC': return { field: 'scoreV2', order: 1 };
    case 'SCORE_DESC': return { field: 'scoreV2', order: -1 };
    case 'XACC_ASC': return { field: 'accuracy', order: 1 };
    case 'XACC_DESC': return { field: 'accuracy', order: -1 };
    case 'DATE_ASC': return { field: 'vidUploadTime', order: 1 };
    case 'DATE_DESC': return { field: 'vidUploadTime', order: -1 };
    default: return { field: 'vidUploadTime', order: -1 }; // Default sort
  }
};

// Helper function to apply query conditions
const applyQueryConditions = (pass: any, query: any) => {
  // Level ID filter
  if (query.levelId && pass.levelId !== query.levelId) {
    return false;
  }

  // Player name filter
  if (query.player) {
    const playerRegex = new RegExp(escapeRegExp(query.player), 'i');
    if (!playerRegex.test(pass.player)) {
      return false;
    }
  }

  return true;
};

const router: Router = Router();

// Main endpoint that handles both findAll and findByQuery
router.get('/', async (req: Request, res: Response) => {
  try {
    const routeStart = performance.now();

    // Filter passes based on query conditions
    let results = passesCache.filter((pass: any) => applyQueryConditions(pass, req.query));
    const count = results.length;

    // Apply sorting
    const { field, order } = getSortOptions(req.query.sort as string);
    
    if (['DATE_ASC', 'DATE_DESC'].includes(req.query.sort as string)) {
      // Date sorting needs special handling
      results.sort((a: any, b: any) => {
        const dateA = Date.parse(a.vidUploadTime);
        const dateB = Date.parse(b.vidUploadTime);
        return order === 1 ? dateA - dateB : dateB - dateA;
      });
    } else {
      // Regular field sorting
      results.sort((a: any, b: any) => {
        return order === 1 
          ? (a[field] > b[field] ? 1 : -1)
          : (a[field] < b[field] ? 1 : -1);
      });
    }

    // Handle pagination if needed
    const offset = req.query.offset ? Number(req.query.offset) : 0;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    
    if (limit !== undefined) {
      results = results.slice(offset, offset + limit);
    }

    const totalTime = performance.now() - routeStart;
    console.log(`[PERF] Total route time: ${totalTime.toFixed(2)}ms`);

    return res.json({ count, results });
  } catch (error) {
    console.error('Error fetching passes:', error);
    return res.status(500).json({ 
      error: 'Failed to fetch passes',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

export default router;
