import { Request, Response, Router } from 'express';
import Player from '../../models/Player';
import Pass from '../../models/Pass';
import Level from '../../models/Level';
import Judgement from '../../models/Judgement';
import { enrichPlayerData } from '../../utils/PlayerEnricher';
import LeaderboardCache from '../../utils/LeaderboardCache';
import { Auth } from '../../middleware/auth';
import { Op } from 'sequelize';

const router: Router = Router();
const leaderboardCache = LeaderboardCache.getInstance();

router.get('/', async (req: Request, res: Response) => {
  try {
    const players = await Player.findAll({
      include: [{
        model: Pass,
        as: 'playerPasses',
        include: [{
          model: Level,
          as: 'level',
          attributes: ['id', 'song', 'artist', 'pguDiff', 'baseScore']
        },
        {
          model: Judgement,
          as: 'judgements',
          attributes: ['earlyDouble', 'earlySingle', 'ePerfect', 'perfect', 'lPerfect', 'lateSingle', 'lateDouble']
        }]
      }]
    });

    const enrichedPlayers = await Promise.all(
      players.map(async player => {
        const enriched = await enrichPlayerData(player);
        const rankings = leaderboardCache.getAllRanks(player.id);
        return { ...enriched, rankings };
      })
    );

    return res.json(enrichedPlayers);
  } catch (error) {
    console.error('Error fetching players:', error);
    return res.status(500).json({ 
      error: 'Failed to fetch players',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const player = await Player.findOne({
      where: { id: req.params.id },
      include: [{
        model: Pass,
        as: 'playerPasses',
        include: [{
          model: Level,
          as: 'level',
          attributes: ['id', 'song', 'artist', 'pguDiff', 'baseScore']
        },
        {
          model: Judgement,
          as: 'judgements',
          attributes: ['earlyDouble', 'earlySingle', 'ePerfect', 'perfect', 'lPerfect', 'lateSingle', 'lateDouble']
        }]
      }]
    });

    if (!player) {
      return res.status(404).json({ error: 'Player not found' });
    }

    const enrichedPlayer = await enrichPlayerData(player);
    const rankings = leaderboardCache.getAllRanks(player.id);
    
    return res.json({
      ...enrichedPlayer,
      rankings
    });
  } catch (error) {
    console.error('Error fetching player:', error);
    return res.status(500).json({ 
      error: 'Failed to fetch player',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});


// Search for players by name
router.get('/search/:name', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    
    // Find players with their passes and level data in a single query
    // This uses Sequelize's eager loading with 'include'
    const players = await Player.findAll({
      where: {
        name: {
          [Op.like]: `%${name}%`
        }
      },
      // Include the passes association
      include: [{
        model: Pass,
        as: 'playerPasses', // This alias must match the one defined in associations.ts
        required: false,    // Use LEFT JOIN to include players even without passes
        include: [{
          model: Level,
          as: 'level',     // This alias must match the one defined in associations.ts
          attributes: ['baseScore', 'pguDiff']
        }]
      }],
      limit: 20
    });

    // Enrich each player with calculated scores
    const enrichedPlayers = await Promise.all(
      players.map(async player => {
        // enrichPlayerData uses the included passes to calculate scores
        // player.playerPasses is now available because of the include above
        const enriched = await enrichPlayerData(player);
        
        // Return only the fields we need for the search results
        return {
          id: enriched.id,
          name: enriched.name,
          country: enriched.country,
          rankedScore: enriched.rankedScore // Keep the original name for frontend compatibility
        };
      })
    );

    // Sort by ranked score descending after enrichment
    enrichedPlayers.sort((a, b) => (b.rankedScore || 0) - (a.rankedScore || 0));

    return res.json(enrichedPlayers);
  } catch (error) {
    console.error('Error searching players:', error);
    return res.status(500).json({ error: error });
  }
});

// Create new player
router.post('/players', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    const { name, country } = req.body;
    const [player, created] = await Player.findOrCreate({
      where: { name },
      defaults: {
        name,
        country,
        pfp: 'none'
      }
    });

    if (!created) {
      return res.status(400).json({ error: 'Player already exists' });
    }

    return res.json(player);
  } catch (error) {
    console.error('Error creating player:', error);
    return res.status(500).json({ error: error });
  }
});


export default router;
