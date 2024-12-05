import { Request, Response, Router } from 'express';
import { PATHS } from '../../config/constants';  
import { readJsonFile } from '../../utils/fileHandlers';
import { decodeFromBase32 } from '../../utils/encodingHelpers';
import { escapeRegExp } from '../../misc/Utility';
import { Cache } from '../../utils/cacheManager';
import Player from '../../models/Player'; // Import the Player model
import Level, { ILevel } from '../../models/Level'; // Add this import
import { IPass } from '../../models/Pass';

const applyQueryConditions = (player: any, query: any) => {
  try {
    // Handle base32 encoded player names
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

    // Get fresh data from cache each time
    let results = Cache.get('players').filter((player: any) => 
      applyQueryConditions(player, req.query)
    );
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
      player.pfp = Cache.get('pfpList')[player.player];
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
  try {
    const player = req.params.player;
    const decodedName = decodeFromBase32(player);
    const playerData = Cache.get('fullPlayerList').find((p: any) => p.player === decodedName);
    playerData.ranks = Cache.get('rankList')[decodedName];
    playerData.pfp = Cache.get('pfpList')[decodedName];
    return res.json(playerData);
  } catch (error) { 
    console.error('Error fetching player:', error);
    return res.status(500).json({ error: 'Failed to fetch player' });
  }
});

// Endpoint to change a player's country code
router.put('/:player/country', async (req: Request, res: Response) => {
  const playerName = req.params.player;
  const { country } = req.body;
  console.log(playerName);
  
  try {
    const player = await Player.findOneAndUpdate(
      { name: playerName },
      { country },
      { new: true }
    );

    if (!player) {
      return res.status(404).json({ error: 'Player not found' });
    }

    return res.json({ message: 'Country updated successfully', player });
  } catch (error) {
    console.error('Error updating country:', error);
    return res.status(500).json({ error: 'Failed to update country' });
  }
});

// Endpoint to ban/unban a player
router.put('/:player/ban', async (req: Request, res: Response) => {
  const playerName = decodeFromBase32(req.params.player);
  const { isBanned } = req.body;

  try {
    const player = await Player.findOne({ name: playerName });

    if (!player) {
      console.log(`Player not found: ${playerName}`);
      return res.status(404).json({ error: 'Player not found' });
    }

    // Check if the current status is different from the requested status
    if (player.isBanned === isBanned) {
      return res.json({
        message: `Player ${playerName} is already ${isBanned ? 'banned' : 'unbanned'}`,
        player
      });
    }

    // Update the player's ban status
    player.isBanned = isBanned;
    await player.save();

    // Update player data in cache
    const playersCache = Cache.get('players');
    const playerIndex = playersCache.findIndex((p: any) => p.name === playerName);
    if (playerIndex !== -1) {
      playersCache[playerIndex].isBanned = isBanned;
      await Cache.set('players', playersCache);
    }

    if (isBanned) {
      console.log(`Banning player: ${playerName}`);
      const playerData = Cache.get('fullPlayerList').find((p: any) => p.player === playerName);
      
      if (playerData && playerData.allScores) {
        // Update clearcount for each chart the player has passed
        for (const score of playerData.allScores) {
          if (!score.isDeleted) {  // Only count non-deleted scores
            const level = await Level.findOne({ id: score.chartId });
            if (level) {
              // Ensure clears won't go negative
              const newClears = Math.max(0, level.clears - 1);
              const updates: any = { clears: newClears };
              
              // If clears becomes 0, set isCleared to false
              if (newClears === 0) {
                updates.isCleared = false;
              }
              
              await Level.findOneAndUpdate(
                { id: score.chartId },
                updates
              );

              // Update the charts cache
              const chartsCache: ILevel[] = Cache.get('charts');
              const chartIndex = chartsCache.findIndex((chart: ILevel) => chart.id === score.chartId);
              if (chartIndex !== -1) {
                chartsCache[chartIndex].clears = newClears;
                if (newClears === 0) {
                  chartsCache[chartIndex].isCleared = false;
                }
              }
              await Cache.set('charts', chartsCache);
            }
          }
        }
      }

      return res.json({ 
        message: `Player ${playerName} banned successfully`, 
        player,
        clearcountsUpdated: playerData?.allScores?.filter((score: IPass) => !score.isDeleted).length || 0
      });
    } else {
      console.log(`Unbanning player: ${playerName}`);
      const playerData = Cache.get('fullPlayerList').find((p: any) => p.player === playerName);
      
      if (playerData && playerData.allScores) {
        for (const score of playerData.allScores) {
          if (!score.isDeleted) {  // Only count non-deleted scores
            const level = await Level.findOne({ id: score.chartId });
            if (level) {
              const updates: any = { 
                clears: level.clears + 1,
                isCleared: true  // Set to true when incrementing clears
              };
              
              await Level.findOneAndUpdate(
                { id: score.chartId },
                updates
              );

              // Update the charts cache
              const chartsCache: ILevel[] = Cache.get('charts');
              const chartIndex = chartsCache.findIndex((chart: ILevel) => chart.id === score.chartId);
              if (chartIndex !== -1) {
                chartsCache[chartIndex].clears++;
                chartsCache[chartIndex].isCleared = true;
              }
              await Cache.set('charts', chartsCache);
            }
          }
        }
      }

      return res.json({ 
        message: `Player ${playerName} unbanned successfully`, 
        player
      });
    }

  } catch (error) {
    console.error('Error updating ban status:', error);
    return res.status(500).json({ error: 'Failed to update ban status' });
  }
});

export default router;
