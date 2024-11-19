import { Request, Response, Router } from 'express';
import { PATHS } from '../../config/constants';  
import { readJsonFile } from '../../utils/fileHandlers';
import { decodeFromBase32 } from '../../utils/encodingHelpers';
import { escapeRegExp } from '../../misc/Utility';

const playersCache = readJsonFile(PATHS.playersJson);
const fullPlayerList = readJsonFile(PATHS.playerlistJson);
const rankList = readJsonFile(PATHS.rankListJson);
const pfpList = readJsonFile(PATHS.pfpListJson);

// Helper function to apply query conditions
const applyQueryConditions = (player: any, query: any) => {
  try {
    // Handle base32 encoded player name
    if (query.player) {
      const decodedName = decodeFromBase32(query.player);
      const nameRegex = new RegExp(escapeRegExp(decodedName), 'i');
      console.log("player.name", player.player)
      return nameRegex.test(player.player);
    }
    
    // Handle regular name query (unencoded)
    if (query.name) {
      const nameRegex = new RegExp(escapeRegExp(query.name), 'i');
      return nameRegex.test(player.player);
    }
    
    // Handle general query (keep for backward compatibility)
    if (query.query) {
      const queryRegex = new RegExp(escapeRegExp(query.query), 'i');
      return queryRegex.test(player.player);
    }
    
    return true;
  } catch (error) {
    console.error('Error in query conditions:', error);
    return false; // Skip invalid queries
  }
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
    
    results.forEach((player: any) => {
      player.pfp = pfpList[player.player];
    }); 

    return res.json({ count, results });
  } catch (error) {
    console.error('Error fetching players:', error);
    return res.status(500).json({ 
      error: 'Failed to fetch players',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

router.get('/:player', async (req: Request, res: Response) => {
  const player = req.params.player;
  const decodedName = decodeFromBase32(player);
  const playerData = fullPlayerList.find((p: any) => p.player === decodedName);
  playerData.ranks = rankList[decodedName];
  playerData.pfp = pfpList[decodedName];
  return res.json(playerData);
});

export default router;
