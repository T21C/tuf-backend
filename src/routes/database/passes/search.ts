
import { Router, Request, Response } from 'express';
import { Auth } from '../../../middleware/auth.js';
import Pass from '../../../models/passes/Pass.js';
import Player from '../../../models/players/Player.js';
import Level from '../../../models/levels/Level.js';
import Judgement from '../../../models/passes/Judgement.js';
import Difficulty from '../../../models/levels/Difficulty.js';
import { logger } from '../../../services/LoggerService.js';
import { PlayerStatsService } from '../../../services/PlayerStatsService.js';
import { User } from '../../../models/index.js';
import { searchPasses } from './index.js';
import { ensureString } from '../../../utils/Utility.js';

const playerStatsService = PlayerStatsService.getInstance();
const router = Router();


router.get('/byId/:id([0-9]+)', Auth.addUserToRequest(), async (req: Request, res: Response) => {
    try {
    const passId = parseInt(req.params.id);
      if (!passId || isNaN(passId) || passId <= 0) {
        return res.status(400).json({error: 'Invalid pass ID'});
      }
      const user = req.user;


      const pass = await Pass.findOne({
        where: user?.isSuperAdmin ? {
          id: passId,
        } : {
          id: passId,
          isDeleted: false,
        },
        include: [
          {
            model: Player,
            as: 'player',
            attributes: ['name', 'country', 'isBanned'],
            where: {isBanned: false},
            required: true,
          },
          {
            model: Level,
            as: 'level',
            required: true,
            attributes: ['song', 'artist', 'baseScore'],
            include: [
              {
                model: Difficulty,
                as: 'difficulty',
                required: true,
              },
            ],
          },
          {
            model: Judgement,
            as: 'judgements',
            required: false,
          },
        ],
      });

      if (!pass) {
        return res.json({count: 0, results: []});
      }

      return res.json({count: 1, results: [pass]});
    }
    catch (error) {
      logger.error('Error fetching pass by ID:', error);
      return res.status(500).json({error: 'Failed to fetch pass'});
    }
  },
);

router.get('/:id([0-9]+)', Auth.addUserToRequest(), async (req: Request, res: Response) => {
    try {
      const passId = parseInt(req.params.id);
      if (!passId || isNaN(passId)) {
        return res.status(400).json({error: 'Invalid pass ID'});
      }
  
  
      const pass = await playerStatsService.getPassDetails(passId, req.user);
      if (!pass) {
        return res.status(404).json({error: 'Pass not found'});
      }
  
      return res.json(pass);
    } catch (error) {
      logger.error('Error fetching pass:', error);
      return res.status(500).json({
        error: 'Failed to fetch pass',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });
  
router.get('/level/:levelId([0-9]+)', async (req: Request, res: Response) => {
    try {
      const {levelId} = req.params;
      const level = await Level.findByPk(levelId);
      if (!level || (level.isDeleted || level.isHidden) && !req.user?.isSuperAdmin) {
        return res.status(404).json({error: 'Level not found'});
      }
      const passes = await Pass.findAll({
        where: {
          levelId: parseInt(levelId),
          isDeleted: false,
          '$player.isBanned$': false,
        },
        include: [
          {
            model: Player,
            as: 'player',
            include: [
              {
                model: User,
                as: 'user',
                attributes: [
                  'id',
                  'username',
                  'nickname',
                  'avatarUrl',
                  'isSuperAdmin',
                  'isRater',
                ],
              },
            ],
          },
          {
            model: Judgement,
            as: 'judgements',
            required: true,
          },
        ],
      });
  
      return res.json(passes);
    } catch (error) {
      logger.error('Error fetching passes:', error);
      return res.status(500).json({error: 'Failed to fetch passes'});
    }
  });
  
  // Update the GET endpoint to use the unified search
  router.get('/', async (req: Request, res: Response) => {
    try {
      const {
        deletedFilter,
        minDiff,
        maxDiff,
        keyFlag,
        levelId,
        player,
        specialDifficulties,
        query: searchQuery,
        offset = '0',
        limit = '30',
        sort,
      } = req.query;
  
      const result = await searchPasses({
        deletedFilter: ensureString(deletedFilter),
        minDiff: ensureString(minDiff),
        maxDiff: ensureString(maxDiff),
        keyFlag: ensureString(keyFlag),
        levelId: ensureString(levelId),
        player: ensureString(player),
        specialDifficulties,
        query: ensureString(searchQuery),
        offset,
        limit,
        sort: ensureString(sort)
      });
  
      return res.json(result);
    } catch (error) {
      logger.error('Error fetching passes:', error);
      return res.status(500).json({error: 'Failed to fetch passes'});
    }
  });

export default router;
