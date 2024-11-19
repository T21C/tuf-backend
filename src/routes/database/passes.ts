import { Request, Response, Router } from 'express';
import { escapeRegExp } from '../../misc/Utility';
import { PATHS } from '../../config/constants';
import { readJsonFile } from '../../utils/fileHandlers';

const passesCache = readJsonFile(PATHS.passesJson);
const playersCache = readJsonFile(PATHS.playersJson);
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
  // Level ID filter - Convert both to strings for comparison
  if (query.levelId && String(pass.levelId) !== String(query.levelId)) {
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

// Helper function to enrich pass data with player info
const enrichPassData = async (pass: any, playersCache: any[]) => {
  const playerInfo = playersCache.find(p => p.name === pass.player);
  return {
    ...pass,
    country: playerInfo?.country || null,
    isBanned: playerInfo?.isBanned || false,
  };
};

const router: Router = Router();

// Main endpoint that handles both findAll and findByQuery
router.get('/', async (req: Request, res: Response) => {
  try {
    const routeStart = performance.now();

    // Filter passes based on query conditions
    let results = passesCache.filter((pass: any) => applyQueryConditions(pass, req.query));
    
    // Enrich with player data
    results = await Promise.all(
      results.map((pass: any) => enrichPassData(pass, playersCache))
    );

    // Filter out banned players
    results = results.filter((pass: any) => !pass.isBanned);

    // Apply sorting
    const { field, order } = getSortOptions(req.query.sort as string);
    results.sort((a: any, b: any) => {
      if (field === 'vidUploadTime') {
        return order * (Date.parse(b.vidUploadTime) - Date.parse(a.vidUploadTime));
      }
      return order * (a[field] > b[field] ? 1 : -1);
    });

    const count = results.length;

    // Handle pagination
    const offset = Number(req.query.offset) || 0;
    const limit = Number(req.query.limit) || undefined;
    if (limit) {
      results = results.slice(offset, offset + limit);
    }

    return res.json({ count, results });
  } catch (error) {
    console.error('Error fetching passes:', error);
    return res.status(500).json({ error: 'Failed to fetch passes' });
  }
});

export default router;
