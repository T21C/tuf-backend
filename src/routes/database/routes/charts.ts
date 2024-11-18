import { Request, Response, Router } from 'express';
import { escapeRegExp } from '../../../misc/Utility';
import Level from '../../../models/Level';
import shuffleSeed from 'shuffle-seed';
import { SortOrder } from 'mongoose';
import { PATHS } from '../../../config/constants';
import { readJsonFile, writeJsonFile } from '../../../utils/fileHandlers';

let chartsCache = readJsonFile(PATHS.chartsJson);

const timeOperation = async (name: string, operation: () => Promise<any>) => {
  const start = performance.now();
  const result = await operation();
  const duration = performance.now() - start;
  console.log(`[PERF] ${name}: ${duration.toFixed(2)}ms`);
  return result;
};

// New function to apply query conditions to cached data
const applyQueryConditions = (chart: any, query: any) => {
  // Text search conditions
  if (query.query) {
    const searchTerm = query.query.toString().toLowerCase();
    if (!chart.song.toLowerCase().includes(searchTerm) &&
        !chart.artist.toLowerCase().includes(searchTerm) &&
        !chart.charter.toLowerCase().includes(searchTerm)) {
      return false;
    }
  }

  // Specific field searches
  if (query.artistQuery && !chart.artist.toLowerCase().includes(query.artistQuery.toString().toLowerCase())) return false;
  if (query.songQuery && !chart.song.toLowerCase().includes(query.songQuery.toString().toLowerCase())) return false;
  if (query.charterQuery && !chart.charter.toLowerCase().includes(query.charterQuery.toString().toLowerCase())) return false;

  // Difficulty filters
  if (query.hideCensored && chart.diff === -2) return false;
  if (query.hideEpic && chart.diff === 0.9) return false;
  if (query.hideUnranked && chart.diff === 0) return false;
  
  if (query.minDiff && chart.pguDiffNum < Number(query.minDiff)) return false;
  if (query.maxDiff && chart.pguDiffNum > Number(query.maxDiff)) return false;

  return true;
};

const getSortOptions = (req: Request): { [key: string]: SortOrder } => {
  const { sort } = req.query;
  switch (sort) {
    case 'RECENT_DESC': return { id: -1 as const };
    case 'RECENT_ASC': return { id: 1 as const };
    case 'DIFF_DESC': return { pdnDiff: -1 as const };
    case 'DIFF_ASC': return { pdnDiff: 1 as const };
    default: return { id: -1 as const };
  }
};

const router: Router = Router();

// List endpoint
router.get('/', async (req: Request, res: Response) => {
  try {
    const routeStart = performance.now();

    if (req.query.sort === 'RANDOM') {
      // Apply the filter conditions
      const results = chartsCache.filter((chart: any) => applyQueryConditions(chart, req.query));
      
      const seed = req.query.seed ? Number(req.query.seed) : 
        Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
      
      const shuffledResults = shuffleSeed.shuffle(results, seed);
      const count = shuffledResults.length;
      
      const offset = req.query.offset ? Number(req.query.offset) : 0;
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      
      const paginatedResults = shuffledResults
        .slice(offset, limit ? offset + limit : undefined);

      return res.json({ count, results: paginatedResults });
    }

    // Apply the filter conditions and sorting
    let results = chartsCache.filter((chart: any) => applyQueryConditions(chart, req.query));
    
    // Apply sorting
    const sortOptions = getSortOptions(req);
    const [sortField, sortOrder] = Object.entries(sortOptions)[0];
    
    results.sort((a: any, b: any) => {
      if (sortOrder === 1) {
        return a[sortField] > b[sortField] ? 1 : -1;
      }
      return a[sortField] < b[sortField] ? 1 : -1;
    });

    const count = results.length;

    // Handle pagination
    const offset = req.query.offset ? Number(req.query.offset) : 0;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const paginatedResults = results.slice(offset, limit ? offset + limit : undefined);

    const totalTime = performance.now() - routeStart;
    console.log(`[PERF] Total route time: ${totalTime.toFixed(2)}ms`);

    return res.json({ count, results: paginatedResults });
  } catch (error) {
    console.error('Error fetching charts:', error);
    return res.status(500).json({ 
      error: 'Failed to fetch charts',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

// Get by ID endpoint
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const routeStart = performance.now();
    
    const item = await Level.findOne({
      $or: [
        { id: req.params.id }
      ]
    });

    if (!item) {
      return res.status(404).json({ error: 'Item not found' });
    }

    const totalTime = performance.now() - routeStart;
    console.log(`[PERF] Total single item time: ${totalTime.toFixed(2)}ms`);

    return res.json(item);
  } catch (error) {
    console.error('Error fetching chart:', error);
    return res.status(500).json({ 
      error: 'Failed to fetch chart',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

// PUT endpoint
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const routeStart = performance.now();
    const { id } = req.params;
    const updateData = req.body;

    // Update in database
    const updatedChart = await Level.findByIdAndUpdate(
      id,
      updateData,
      { new: true, runValidators: true }
    );

    if (!updatedChart) {
      return res.status(404).json({ error: 'Chart not found' });
    }

    // Update in cache
    const chartIndex = chartsCache.findIndex((chart: any) => chart._id.toString() === id);
    if (chartIndex !== -1) {
      chartsCache[chartIndex] = {
        ...chartsCache[chartIndex],
        ...updateData
      };

      // Write updated cache to file
      await writeJsonFile(PATHS.chartsJson, chartsCache);
    }

    const totalTime = performance.now() - routeStart;
    console.log(`[PERF] Total update time: ${totalTime.toFixed(2)}ms`);

    return res.json(updatedChart);
  } catch (error) {
    console.error('Error updating chart:', error);
    return res.status(500).json({ 
      error: 'Failed to update chart',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

export default router;
