import { Request, Response, Router } from 'express';
import Level from '../../models/Level';
import shuffleSeed from 'shuffle-seed';
import { SortOrder } from 'mongoose';
import { Rating } from '../../models/Rating';
import { calculateBaseScore } from '../../utils/ratingUtils';
import { calculatePguDiffNum } from '../../utils/ratingUtils';
import { Auth } from '../../middleware/auth';
import { getIO } from '../../utils/socket';
import { Cache } from '../../utils/cacheManager';
import { reloadPasses, updateData } from '../../utils/updateHelpers';

const timeOperation = async (name: string, operation: () => Promise<any>) => {
  const start = performance.now();
  const result = await operation();
  const duration = performance.now() - start;
  console.log(`[PERF] ${name}: ${duration.toFixed(2)}ms`);
  return result;
};

// New function to apply query conditions to cached data
const applyQueryConditions = (chart: any, query: any) => {
  // Handle deleted charts based on deletedFilter
  const deletedFilter = query.deletedFilter || 'hide';
  if (deletedFilter === 'hide' && chart.isDeleted) {
    return false;
  }
  if (deletedFilter === 'only' && !chart.isDeleted) {
    return false;
  }
  // 'show' will display both deleted and non-deleted charts

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
  if (query.hideCensored === 'true' && chart.diff === -2) return false;
  if (query.hideEpic === 'true' && chart.diff === 0.9) return false;
  if (query.hideUnranked === 'true' && chart.diff == 0) return false;
  
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
      const results = Cache.get('charts').filter((chart: any) => applyQueryConditions(chart, req.query));
      
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
    let results = Cache.get('charts').filter((chart: any) => applyQueryConditions(chart, req.query));
    
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
    const item = Cache.get('charts').find((chart: any) => chart.id === parseInt(req.params.id));

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
router.put('/:id', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    const routeStart = performance.now();
    const { id } = req.params;
    const updateChartData = req.body;

    // Calculate pguDiffNum and baseScore
    updateChartData.pguDiffNum = calculatePguDiffNum(updateChartData.pguDiff);
    updateChartData.baseScoreDiff = updateChartData.baseScoreDiff.toString();
    const parsedBaseScore = Number(updateChartData.baseScoreDiff);
    updateChartData.baseScore = !isNaN(parsedBaseScore) && parsedBaseScore > 0 
      ? parsedBaseScore 
      : calculateBaseScore(calculatePguDiffNum(updateChartData.baseScoreDiff));

    // Update chart in database
    const updatedChart = await Level.findByIdAndUpdate(
      id,
      updateChartData,
      { new: true, runValidators: true }
    );

    if (!updatedChart) {
      return res.status(404).json({ error: 'Chart not found' });
    }
    // Update charts cache
    const chartsCache = Cache.get('charts');
    const chartIndex = chartsCache.findIndex((chart: any) => chart._id.toString() === id);
    
    const io = getIO();
    io.emit('ratingsUpdated');
    // Handle Rating entry based on toRate flag
    if (updateChartData.toRate) {
      // Create or update rating
      await Rating.findOneAndUpdate(
        { ID: updatedChart.id },
        {
          ID: updatedChart.id,
          song: updatedChart.song || "",
          artist: updatedChart.artist || "",
          creator: updatedChart.charter || "",
          rawVideoLink: updatedChart.vidLink || "",
          rawDLLink: updatedChart.dlLink || "",
          rerateReason: updatedChart.rerateReason || "",
          rerateNum: updatedChart.rerateNum || "",
          ...(updatedChart.rerateNum ? { requesterFR: "" } : {})
        },
        { upsert: true }
      );
    } else {
      // Remove rating if it exists
      await Rating.deleteOne({ ID: updatedChart.id });
    }
    // Update in cache
    if (chartIndex !== -1) {
      chartsCache[chartIndex] = {
        ...chartsCache[chartIndex],
        ...updateChartData
      };
      await Cache.set('charts', chartsCache);
    }
    updateData(false).then(async () => {
      Cache.reloadAll();
    });
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

// DELETE endpoint
router.patch('/:id/soft-delete', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    const routeStart = performance.now();
    const { id } = req.params;

    // Soft delete in database
    const updatedChart = await Level.findByIdAndUpdate(
      id,
      { isDeleted: true },
      { new: true }
    );

    if (!updatedChart) {
      return res.status(404).json({ error: 'Chart not found' });
    }

    // Emit socket update
    const io = getIO();
    io.emit('ratingsUpdated');

    // Remove rating if it exists
    await Rating.deleteOne({ ID: updatedChart.id });

    // Update cache with soft deleted status
    const chartsCache = Cache.get('charts');
    const updatedCache = chartsCache.map((chart: any) => 
      chart._id.toString() === id ? { ...chart, isDeleted: true } : chart
    );
    
    await Cache.set('charts', updatedCache);
    
    // Update related data
    await updateData(false);

    const totalTime = performance.now() - routeStart;
    console.log(`[PERF] Total soft delete time: ${totalTime.toFixed(2)}ms`);

    return res.json({ 
      message: 'Chart soft deleted successfully', 
      deletedChart: updatedChart 
    });
  } catch (error) {
    console.error('Error soft deleting chart:', error);
    return res.status(500).json({ 
      error: 'Failed to soft delete chart',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

// Add new RESTORE endpoint
router.patch('/:id/restore', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    const routeStart = performance.now();
    const { id } = req.params;

    // Restore in database
    const restoredChart = await Level.findByIdAndUpdate(
      id,
      { isDeleted: false },
      { new: true }
    );

    if (!restoredChart) {
      return res.status(404).json({ error: 'Chart not found' });
    }

    // Update cache
    const chartsCache = Cache.get('charts');
    const updatedCache = chartsCache.map((chart: any) => 
      chart._id.toString() === id ? { ...chart, isDeleted: false } : chart
    );
    
    await Cache.set('charts', updatedCache);
    
    // Update related data
    await updateData(false);

    const io = getIO();
    io.emit('ratingsUpdated');

    const totalTime = performance.now() - routeStart;
    console.log(`[PERF] Total restore time: ${totalTime.toFixed(2)}ms`);

    return res.json({ 
      message: 'Chart restored successfully', 
      restoredChart 
    });
  } catch (error) {
    console.error('Error restoring chart:', error);
    return res.status(500).json({ 
      error: 'Failed to restore chart',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

export default router;
