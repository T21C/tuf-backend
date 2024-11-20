import { Request, Response, Router } from 'express';
import { escapeRegExp } from '../../misc/Utility';
import { PATHS } from '../../config/constants';
import { readJsonFile, writeJsonFile } from '../../utils/fileHandlers';
import { updateCache } from '../../utils/updateHelpers';
import Pass from '../../models/Pass';

const passesCache = readJsonFile(PATHS.passesJson);
const playersCache = readJsonFile(PATHS.playersJson);
const clearListCache = readJsonFile(PATHS.clearlistJson);
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
    let results = clearListCache.filter((pass: any) => applyQueryConditions(pass, req.query));
    
    // Enrich with player data
    results = await Promise.all(
      results.map((pass: any) => enrichPassData(pass, clearListCache))
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

interface PassUpdateData {
  player: string;
  song: string;
  artist: string;
  score: number;
  pguDiff: string;
  Xacc: number;
  speed: number | null;
  isWorldsFirst: boolean;
  vidLink: string;
  date: string;
  is12K: boolean;
  isNoHold: boolean;
  judgements: number[];
  pdnDiff: number;
  chartId: number;
  passId: number;
  baseScore: number;
}

router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const updateData: PassUpdateData = req.body;

    // Update in database
    const updatedPass = await Pass.findOneAndUpdate(
      { id: parseInt(id) },
      {
        player: updateData.player,
        speed: updateData.speed,
        vidTitle: updateData.song, // Assuming this mapping
        vidLink: updateData.vidLink,
        vidUploadTime: updateData.date,
        is12k: updateData.is12K,
        isNHT: updateData.isNoHold,
        judgements: updateData.judgements,
        accuracy: updateData.Xacc,
        scoreV2: updateData.score
      },
      { new: true }
    );

    if (!updatedPass) {
      return res.status(404).json({ error: 'Pass not found' });
    }

    // Update clearListCache
    const passIndex = clearListCache.findIndex((pass: any) => pass.passId === parseInt(id));
    if (passIndex !== -1) {
      clearListCache[passIndex] = {
        ...clearListCache[passIndex],
        ...updateData
      };
      await writeJsonFile(PATHS.clearlistJson, clearListCache);
    }


    return res.json({
      message: 'Pass updated successfully',
      pass: updatedPass
    });

  } catch (error) {
    console.error('Error updating pass:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
