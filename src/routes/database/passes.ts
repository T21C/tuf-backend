import { Request, Response, Router } from 'express';
import { escapeRegExp } from '../../misc/Utility';
import { PATHS } from '../../config/constants';
import { readJsonFile, writeJsonFile } from '../../utils/fileHandlers';
import { getPassesReloadCooldown, reloadPasses, updateData } from '../../utils/updateHelpers';
import Pass, { IPass } from '../../models/Pass';
import { getScoreV2 } from '../../misc/CalcScore';
import { calcAcc } from '../../misc/CalcAcc';
import { IJudgements } from '../../models/Judgements';
import { Auth } from '../../middleware/auth';
import Level, { ILevel } from '../../models/Level';
import { Cache } from '../../utils/cacheManager';
import { getIO } from '../../utils/socket';

const router: Router = Router();

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
  // Handle deleted passes based on deletedFilter
  const deletedFilter = query.deletedFilter || 'hide';
  if (deletedFilter === 'hide' && pass.isDeleted) {
    return false;
  }
  if (deletedFilter === 'only' && !pass.isDeleted) {
    return false;
  }
  // 'show' will display both deleted and non-deleted passes
  
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

  if (query.query) {
    const queryRegex = new RegExp(escapeRegExp(query.query), 'i');
    if (!queryRegex.test(pass.player)   &&
        !queryRegex.test(pass.song)     &&
        !queryRegex.test(pass.artist)   &&
        !queryRegex.test(pass.pguDiff)  &&
        !queryRegex.test(pass.chartId)  &&
        !queryRegex.test(pass.passId)
      ) {
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
    pfp: Cache.get('pfpList')[playerInfo?.name] || null
  };
};


router.get('/level/:chartId', async (req: Request, res: Response) => {
  const { chartId } = req.params;
  const passes = Cache.get('passes').filter((pass: any) => pass.levelId === parseInt(chartId));    
  const enrichedPasses = await Promise.all(
    passes.map((pass: any) => enrichPassData(pass, Cache.get('players')))
  );
  return res.json(enrichedPasses);
});

// Main endpoint that handles both findAll and findByQuery
router.get('/', async (req: Request, res: Response) => {
  try {
    const routeStart = performance.now();

    console.log(req.query, req.body)
    // Filter passes based on query conditions
    let results = Cache.get('clearList').filter((pass: any) => applyQueryConditions(pass, req.query));
    
    // Enrich with player data
    results = await Promise.all(
      results.map((pass: any) => enrichPassData(pass, Cache.get('players')))
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
    const offset = req.query.offset ? Number(req.query.offset) : 0;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const paginatedResults = results.slice(offset, limit ? offset + limit : undefined);
    const totalTime = performance.now() - routeStart;
    console.log(`[PERF] Total route time: ${totalTime.toFixed(2)}ms`);

    return res.json({ count, results: paginatedResults });
  } catch (error) {
    console.error('Error fetching passes:', error);
    return res.status(500).json({ error: 'Failed to fetch passes' });
  }
});

router.get('/:id', async (req: Request, res: Response) => {
  console.log('GET request received for pass:', req.params.id);
  try {
    const { id } = req.params;
    
    const pass = Cache.get('passes').find((pass: any) => pass.id === parseInt(id));

    
    if (!pass) {
      return res.status(404).json({ error: 'Pass not found' });
    }
    return res.json(pass);
  } catch (error) {
    console.error('Error fetching pass:', error);
    return res.status(500).json({ error: 'Failed to fetch pass' });
  }
});


router.put('/:id', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    // Get the original pass to check if level changed
    const originalPass = await Pass.findOne({ id: parseInt(id) });
    const newLevelId = req.body['levelId'];

    // If level ID changed, update both old and new level clear counts
    if (originalPass && originalPass.levelId !== newLevelId) {
      // Verify both levels exist first
      const [oldLevel, newLevel] = await Promise.all([
        Level.findOne({ id: originalPass.levelId }),
        Level.findOne({ id: newLevelId })
      ]);

      if (!oldLevel || !newLevel) {
        return res.status(400).json({ 
          error: 'Invalid level IDs',
          oldLevelExists: !!oldLevel,
          newLevelExists: !!newLevel
        });
      }

      // Update levels in database
      const [updatedOldLevel, updatedNewLevel] = await Promise.all([
        Level.findOneAndUpdate(
          { id: originalPass.levelId },
          { $inc: { clears: -1 } },
          { new: true }
        ),
        Level.findOneAndUpdate(
          { id: newLevelId },
          { $inc: { clears: 1 } },
          { new: true }
        )
      ]).catch(error => {
        console.error('Error updating level clear counts:', error);
        throw new Error('Failed to update level clear counts');
      });

      // Update levels in cache
      const levelsCache = Cache.get('charts');
      const updatedLevelsCache = levelsCache.map((level: any) => {
        if (level.id === originalPass.levelId) {
          return updatedOldLevel ? updatedOldLevel.toObject() : level;
        }
        if (level.id === newLevelId) {
          return updatedNewLevel ? updatedNewLevel.toObject() : level;
        }
        return level;
      });

      await Cache.set('charts', updatedLevelsCache);
    }

    console.log('PUT/PATCH request received for pass:', id);
    
    //console.log(req.body)
    // Convert array to IJudgements object
    const judgementObj: IJudgements = req.body['judgements'];

    //console.log(judgementObj)
    // Calculate score and accuracy from judgements
    const calculatedScore = getScoreV2({
      speed: req.body['speedTrial'],
      judgements: judgementObj,
      isNoHoldTap: req.body['isNHT']
    }, { baseScore: req.body['baseScore'] });

    const calculatedAcc = calcAcc(judgementObj);

    // Verify calculations match submitted values


    // Update in database
    console.log(req.body)
    const formData = {
      levelId: req.body['levelId'],
      speed: req.body['speed'],
      passer: req.body['leaderboardName'],
      feelingRating: req.body['feelingRating'],
      title: req.body['title'],
      rawVideoId: req.body['rawVideoId'],
      rawTime: new Date(req.body['videoDetails']['timestamp']),
      judgements: req.body['judgements'],
      flags: {
          is12k: req.body['is12k'],
          isNHT: req.body['isNoHold'],
          is16k: req.body['is16k']
      }
    }

    console.log("formData", formData)

    const passUpdateData = {
      id: id,
      levelId: formData.levelId,
      speed: formData.speed,
      player: formData.passer,
      feelingRating: formData.feelingRating,
      vidTitle: formData.title,
      vidLink: formData.rawVideoId,
      vidUploadTime: formData.rawTime,
      is12K: formData.flags.is12k,
      is16K: formData.flags.is16k,
      isNoHoldTap: formData.flags.isNHT,
      accuracy: calculatedAcc,
      scoreV2: calculatedScore,
      judgements: {
        earlyDouble: formData.judgements.earlyDouble,
        earlySingle: formData.judgements.earlySingle,
        ePerfect: formData.judgements.ePerfect,
        perfect: formData.judgements.perfect,
        lPerfect: formData.judgements.lPerfect,
        lateSingle: formData.judgements.lateSingle,
        lateDouble: formData.judgements.lateDouble
      }
    }

    const updatedPass = await Pass.findOneAndUpdate(
      { id: parseInt(id) },
      passUpdateData,
      { new: true }
    );

    if (!updatedPass) {
      return res.status(404).json({ error: 'Pass not found' });
    }

    console.log("updatedPass", updatedPass)
    // Update the cache immediately
    const passesCache = await Cache.get('passes');
    const clearListCache = await Cache.get('clearList');

    // Update both caches
    const updatedPassesCache = passesCache.map((pass: any) => 
      pass.id === parseInt(id) ? updatedPass.toObject() : pass
    );
    const updatedClearListCache = clearListCache.map((pass: any) => 
      pass.id === parseInt(id) ? updatedPass.toObject() : pass
    );

    await Promise.all([
      Cache.set('passes', updatedPassesCache),
      Cache.set('clearList', updatedClearListCache)
    ]);

    // Optional: Emit socket update to notify clients
    const io = getIO();
    io.emit('passesUpdated');

    // The existing updateData call
    updateData(false)

    return res.json({
      message: 'Pass updated successfully',
      pass: updatedPass
    });

  } catch (error) {
    console.error('Error updating pass:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Modify DELETE endpoint to implement soft delete
router.patch('/:id/soft-delete', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    // Get the pass before soft deletion
    const pass = await Pass.findOne({ id: parseInt(id) });
    
    if (!pass) {
      return res.status(404).json({ error: 'Pass not found' });
    }

    // Soft delete the pass
    const updatedPass = await Pass.findOneAndUpdate(
      { id: parseInt(id) },
      { isDeleted: true },
      { new: true }
    );

    // Update level clear count
    await Level.findOneAndUpdate(
      { id: pass.levelId },
      { $inc: { clears: -1 } }
    );

    // Update caches
    const passesCache = Cache.get('passes');
    const clearListCache = Cache.get('clearList');
    const levelsCache = Cache.get('charts');

    // Update both pass caches with soft delete status
    const updatedPassesCache = passesCache.map((p: IPass) => 
      p.id === parseInt(id) ? { ...p, isDeleted: true } : p
    );
    const updatedClearListCache = clearListCache.map((p: IPass) => 
      p.id === parseInt(id) ? { ...p, isDeleted: true } : p
    );

    // Update level cache
    const updatedLevelsCache = levelsCache.map((level: ILevel) => {
      if (level.id === pass.levelId) {
        return { ...level, clears: level.clears - 1 };
      }
      return level;
    });

    // Update all caches atomically
    await Promise.all([
      Cache.set('passes', updatedPassesCache),
      Cache.set('clearList', updatedClearListCache),
      Cache.set('charts', updatedLevelsCache)
    ]);

    // Notify clients
    const io = getIO();
    io.emit('passesUpdated');
    updateData(false);

    return res.json({ 
      message: 'Pass soft deleted successfully',
      pass: updatedPass 
    });
  } catch (error) {
    console.error('Error soft deleting pass:', error);
    return res.status(500).json({ error: 'Failed to soft delete pass' });
  }
});

// Add new RESTORE endpoint
router.patch('/:id/restore', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    // Get the pass before restoration
    const pass = await Pass.findOne({ id: parseInt(id) });
    
    if (!pass) {
      return res.status(404).json({ error: 'Pass not found' });
    }

    // Restore the pass
    const restoredPass = await Pass.findOneAndUpdate(
      { id: parseInt(id) },
      { isDeleted: false },
      { new: true }
    );

    // Update level clear count
    await Level.findOneAndUpdate(
      { id: pass.levelId },
      { $inc: { clears: 1 } }
    );

    // Update caches
    const passesCache = Cache.get('passes');
    const clearListCache = Cache.get('clearList');
    const levelsCache = Cache.get('charts');

    // Update both pass caches with restored status
    const updatedPassesCache = passesCache.map((p: IPass) => 
      p.id === parseInt(id) ? { ...p, isDeleted: false } : p
    );
    const updatedClearListCache = clearListCache.map((p: IPass) => 
      p.id === parseInt(id) ? { ...p, isDeleted: false } : p
    );

    // Update level cache
    const updatedLevelsCache = levelsCache.map((level: ILevel) => {
      if (level.id === pass.levelId) {
        return { ...level, clears: level.clears + 1 };
      }
      return level;
    });

    // Update all caches atomically
    await Promise.all([
      Cache.set('passes', updatedPassesCache),
      Cache.set('clearList', updatedClearListCache),
      Cache.set('charts', updatedLevelsCache)
    ]);

    // Notify clients
    const io = getIO();
    io.emit('passesUpdated');

    updateData(false);
    return res.json({ 
      message: 'Pass restored successfully',
      pass: restoredPass 
    });
  } catch (error) {
    console.error('Error restoring pass:', error);
    return res.status(500).json({ error: 'Failed to restore pass' });
  }
});

export default router;
