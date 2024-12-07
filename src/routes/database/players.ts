import { Request, Response, Router } from 'express';
import { Op } from 'sequelize';
import { decodeFromBase32 } from '../../utils/encodingHelpers';
import Player from '../../models/Player';
import Pass from '../../models/Pass';
import Level from '../../models/Level';
import Judgement from '../../models/Judgement';
import { enrichPlayerData } from '../../utils/PlayerEnricher';
import { Cache } from '../../utils/cacheManager';
import { ILevel, IPass } from '../../types/models';
import sequelize from '../../config/db';

const router: Router = Router();

router.get('/', async (req: Request, res: Response) => {
  try {
    const routeStart = performance.now();

    // Build where clause based on query params
    const whereClause: any = {};
    if (req.query.name) {
      whereClause.name = { [Op.like]: `%${req.query.name}%` };
    }
    if (req.query.player) {
      const decodedName = decodeFromBase32(req.query.player as string);
      whereClause.name = { [Op.like]: `%${decodedName}%` };
    }

    // Get players with their passes and related data
    const players = await Player.findAll({
      where: whereClause,
      include: [{
        model: Pass,
        include: [{
          model: Level,
          attributes: ['id', 'song', 'artist', 'pguDiff', 'baseScore']
        },
        {
          model: Judgement,
          attributes: ['earlyDouble', 'earlySingle', 'ePerfect', 'perfect', 'lPerfect', 'lateSingle', 'lateDouble']
        }]
      }]
    });

    // Enrich player data with calculated fields
    const enrichedPlayers = await Promise.all(
      players.map(player => enrichPlayerData(player))
    );

    const count = enrichedPlayers.length;

    // Handle pagination
    const offset = req.query.offset ? Number(req.query.offset) : 0;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const results = enrichedPlayers.slice(offset, limit ? offset + limit : undefined);

    const totalTime = performance.now() - routeStart;
    console.log(`[PERF] Total route time: ${totalTime.toFixed(2)}ms`);

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
    const decodedName = decodeFromBase32(req.params.player);
    
    const player = await Player.findOne({
      where: { name: decodedName },
      include: [{
        model: Pass,
        include: [{
          model: Level,
          attributes: ['id', 'song', 'artist', 'pguDiff', 'baseScore']
        },
        {
          model: Judgement,
          attributes: ['earlyDouble', 'earlySingle', 'ePerfect', 'perfect', 'lPerfect', 'lateSingle', 'lateDouble']
        }]
      }]
    });

    if (!player) {
      return res.status(404).json({ error: 'Player not found' });
    }

    const enrichedPlayer = await enrichPlayerData(player);
    return res.json(enrichedPlayer);
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
    const [affectedCount, [player]] = await Player.update(
      { country },
      { 
        where: { name: playerName },
        returning: true
      }
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
    const [affectedCount, [player]] = await Player.update(
      { isBanned },
      { 
        where: { name: playerName },
        returning: true
      }
    );

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
            const level = await Level.findOne({ where: { id: score.chartId } });
            if (level) {
              // Ensure clears won't go negative
              const newClears = Math.max(0, level.clears - 1);
              const updates: any = { clears: newClears };
              
              // If clears becomes 0, set isCleared to false
              if (newClears === 0) {
                updates.isCleared = false;
              }
              
              await Level.update(
                { 
                  clears: sequelize.literal('clears - 1'),
                  isCleared: sequelize.literal('CASE WHEN clears - 1 <= 0 THEN false ELSE isCleared END')
                },
                { 
                  where: { id: score.chartId }
                }
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
            const level = await Level.findOne({ where: { id: score.chartId } });
            if (level) {
              const updates: any = { 
                clears: level.clears + 1,
                isCleared: true  // Set to true when incrementing clears
              };
              
              await Level.update(
                { 
                  clears: sequelize.literal('clears + 1'),
                  isCleared: true
                },
                { 
                  where: { id: score.chartId }
                }
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
