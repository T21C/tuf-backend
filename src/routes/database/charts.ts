import { Request, Response, Router } from 'express';
import { escapeRegExp } from '../../misc/Utility';
import Level from '../../models/Level';
import shuffleSeed from 'shuffle-seed';
import { SortOrder } from 'mongoose';
import { PATHS } from '../../config/constants';
import { readJsonFile, writeJsonFile } from '../../utils/fileHandlers';
import { Rating } from '../../models/Rating';

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

function calculatePguDiffNum(pguDiff: string): number {
  if (!pguDiff) return 0;

  const difficultyMap: { [key: string]: number } = {
    "Unranked": 0,
    ...Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`P${i + 1}`, i + 1])),
    ...Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`G${i + 1}`, i + 21])),
    ...Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`U${i + 1}`, i + 41])),
    "QQ": 61,
    "Q2": 62,
    "Q2p": 63,
    "Q3": 64,
    "Q3p": 65,
    "Q4": 66,
    "MP": -22,
    "Grande": 100,
    "Bus": 101,
    "MA": 102,
  };

  // Convert the array of entries back to an object
  const diffMap = Object.fromEntries(Object.entries(difficultyMap));

  // Try to parse as number first
  const numericValue = Number(pguDiff);
  if (!isNaN(numericValue)) {
    return numericValue;
  }

  // Look up in difficulty map
  return diffMap[pguDiff] || 0;
}

function calculateBaseScore(value: number): number {
  if (!value || value < 1) return 0;

  const scoreMap: { [key: number]: number } = {
    1: 0.1,  2: 0.2,  3: 0.3,  4: 0.4,  5: 0.5,
    6: 0.6,  7: 0.7,  8: 0.8,  9: 0.9,  10: 1,
    11: 2,   12: 3,   13: 5,   14: 10,  15: 15,
    16: 20,  17: 30,  18: 45,  19: 60,  20: 75,
    21: 100, 22: 110, 23: 120, 24: 130, 25: 140,
    26: 150, 27: 160, 28: 170, 29: 180, 30: 190,
    31: 200, 32: 210, 33: 220, 34: 230, 35: 240,
    36: 250, 37: 275, 38: 300, 39: 350, 40: 400,
    41: 500, 42: 600, 43: 700, 44: 850, 45: 1000,
    46: 1300, 47: 1600, 48: 1800, 49: 2000, 50: 2500,
    51: 3000, 52: 4000, 53: 5000, 54: 11000,
    [-21]: 0, [-22]: 0, [-1]: 0.1, [-2]: 0
  };

  return scoreMap[value] ?? 0;
}

// PUT endpoint
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const routeStart = performance.now();
    const { id } = req.params;
    const updateData = req.body;

    // Calculate pguDiffNum
    updateData.pguDiffNum = calculatePguDiffNum(updateData.pguDiff);
    updateData.baseScoreDiff = updateData.baseScoreDiff.toString();
    const parsedBaseScore = Number(updateData.baseScoreDiff);
    updateData.baseScore = !isNaN(parsedBaseScore) && parsedBaseScore > 0 
      ? parsedBaseScore 
      : calculateBaseScore(calculatePguDiffNum(updateData.baseScoreDiff));
    // Update in database
    const updatedChart = await Level.findByIdAndUpdate(
      id,
      updateData,
      { new: true, runValidators: true }
    );

    if (!updatedChart) {
      return res.status(404).json({ error: 'Chart not found' });
    }

    // Handle Rating entry based on toRate flag
    if (updateData.toRate) {
      // Create or update rating
      await Rating.findOneAndUpdate(
        { ID: updatedChart.id },
        {
          ID: updatedChart.id,
          song: updatedChart.song,
          artist: updatedChart.artist,
          creator: updatedChart.charter,
          rawVideoLink: updatedChart.vidLink,
          rawDLLink: updatedChart.dlLink,
        },
        { upsert: true }
      );
    } else {
      // Remove rating if it exists
      await Rating.deleteOne({ ID: updatedChart.id });
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
