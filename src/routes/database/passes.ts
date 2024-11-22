import { Request, Response, Router } from 'express';
import { escapeRegExp } from '../../misc/Utility';
import { PATHS } from '../../config/constants';
import { readJsonFile, writeJsonFile } from '../../utils/fileHandlers';
import { updateCache } from '../../utils/updateHelpers';
import Pass from '../../models/Pass';
import { getScoreV2 } from '../../misc/CalcScore';
import { calcAcc } from '../../misc/CalcAcc';
import { IJudgements } from '../../models/Judgements';

let passesCache = readJsonFile(PATHS.passesJson);
let playersCache = readJsonFile(PATHS.playersJson);
let clearListCache = readJsonFile(PATHS.clearlistJson);
let pfpCache = readJsonFile(PATHS.pfpListJson);




const reloadCache = () => {
  passesCache = readJsonFile(PATHS.passesJson);
  playersCache = readJsonFile(PATHS.playersJson);
  clearListCache = readJsonFile(PATHS.clearlistJson);
  pfpCache = readJsonFile(PATHS.pfpListJson);
}
// Reload cache every minute
setInterval(reloadCache, 1000 * 60);

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
  if (query.chartId && String(pass.chartId) !== String(query.chartId)) {
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
    pfp: pfpCache[playerInfo?.name] || null
  };
};

const router: Router = Router();

router.get('/level/:chartId', async (req: Request, res: Response) => {
  const { chartId } = req.params;
  console.log(chartId)
  const passes = clearListCache.filter((pass: any) => pass.chartId === parseInt(chartId));    
  const enrichedPasses = await Promise.all(
    passes.map((pass: any) => enrichPassData(pass, playersCache))
  );
  return res.json(enrichedPasses);
});

// Main endpoint that handles both findAll and findByQuery
router.get('/', async (req: Request, res: Response) => {
  try {
    const routeStart = performance.now();

    console.log(req.query, req.body)
    // Filter passes based on query conditions
    let results = clearListCache.filter((pass: any) => applyQueryConditions(pass, req.query));
    
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

router.get('/:id', async (req: Request, res: Response) => {
  console.log('GET request received for pass:', req.params.id);
  try {
    const { id } = req.params;
    const pass = passesCache.find((pass: any) => pass.id === parseInt(id));
    if (!pass) {
      return res.status(404).json({ error: 'Pass not found' });
    }
    return res.json(pass);
  } catch (error) {
    console.error('Error fetching pass:', error);
    return res.status(500).json({ error: 'Failed to fetch pass' });
  }
});


router.put('/:id', async (req: Request, res: Response) => {
  console.log('PUT/PATCH request received for pass:', req.params.id);
  try {
    const { id } = req.params;

    console.log(req.body)
    // Convert array to IJudgements object
    const judgementObj: IJudgements = req.body['judgements'];

    console.log(judgementObj)
    // Calculate score and accuracy from judgements
    const calculatedScore = getScoreV2({
      speed: req.body['speedTrial'],
      judgements: judgementObj,
      isNoHoldTap: req.body['isNHT']
    }, { baseScore: req.body['baseScore'] });

    const calculatedAcc = calcAcc(judgementObj);

    // Verify calculations match submitted values


    // Update in database

    const formData = {
      levelId: req.body['levelId'],
      speed: !!req.body['speed'],
      passer: req.body['passer'],
      feelingRating: req.body['feelingRating'],
      title: req.body['title'],
      rawVideoId: req.body['rawVideoId'],
      rawTime: new Date(req.body['videoDetails']['timestamp']),
      judgements: req.body['judgements'],
      flags: {
          is12k: req.body['is12k'],
          isNHT: req.body['isNHT'],
          is16k: req.body['is16k']
      }
    }

    const passUpdateData = {
      id: id,
      levelId: formData.levelId,
      speed: formData.speed,
      player: formData.passer,
      feelingRating: formData.feelingRating,
      vidTitle: formData.title,
      vidLink: formData.rawVideoId,
      vidUploadTime: formData.rawTime,
      is12k: formData.flags.is12k,
      is16k: formData.flags.is16k,
      isNoHoldTap: formData.flags.isNHT,
      accuracy: calculatedAcc,
      scoreV2: calculatedScore,
      judgements: [
        formData.judgements.earlyDouble,
        formData.judgements.earlySingle,
        formData.judgements.ePerfect,
        formData.judgements.perfect,
        formData.judgements.lPerfect,
        formData.judgements.lateSingle,
        formData.judgements.lateDouble
      ]
    }

    const updatedPass = await Pass.findOneAndUpdate(
      { id: parseInt(id) },
      passUpdateData,
      { new: true }
    );

    console.log(updatedPass)
    if (!updatedPass) {
      return res.status(404).json({ error: 'Pass not found' });
    }

    // Clear cache to force refresh
    reloadCache();

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
