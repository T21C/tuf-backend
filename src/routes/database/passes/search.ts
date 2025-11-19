
import { Router, Request, Response } from 'express';
import { Auth } from '../../../middleware/auth.js';
import { Op } from 'sequelize';
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
import { hasFlag, wherePermission } from '../../../utils/auth/permissionUtils.js';
import { permissionFlags } from '../../../config/constants.js';
import Creator from '../../../models/credits/Creator.js';
import LevelCredit from '../../../models/levels/LevelCredit.js';
import Team from '../../../models/credits/Team.js';

const playerStatsService = PlayerStatsService.getInstance();
const router = Router();


router.get('/byId/:id([0-9]{1,20})', Auth.addUserToRequest(), async (req: Request, res: Response) => {
    try {
    const passId = parseInt(req.params.id);
      if (!passId || isNaN(passId) || passId <= 0) {
        return res.status(400).json({error: 'Invalid pass ID'});
      }
      const user = req.user;

      // Base pass query
      const passPromise = Pass.findOne({
        where: user && hasFlag(user, permissionFlags.SUPER_ADMIN) ? {
          id: passId,
        } : {
          id: passId,
          isDeleted: false,
        },
      });

      const pass = await passPromise;
      if (!pass) {
        return res.json({count: 0, results: []});
      }

      // Fetch related data concurrently
      const [player, level, judgement] = await Promise.all([
        // Player query
        Player.findOne({
          where: { id: pass.playerId, isBanned: false },
          attributes: ['name', 'country'],
          include: [{
            model: User,
            as: 'user',
            required: false,
            where: {
              [Op.and]: [
                wherePermission(permissionFlags.BANNED, false)
              ]
            }
          }]
        }),
        // Level query
        Level.findOne({
          where: { id: pass.levelId },
          attributes: ['song', 'artist', 'baseScore', 'diffId', 'teamId'],
        }).then(async (level) => {
          if (!level) return null;

          const [difficulty, levelCredits, team] = await Promise.all([
            Difficulty.findOne({
              where: { id: level.diffId },
            }),
            level.id ? LevelCredit.findAll({
              where: { levelId: level.id },
            }).then(async (credits) => {
              if (credits.length === 0) return [];
              
              const creatorIds = [...new Set(credits.map(c => c.creatorId).filter((id): id is number => Boolean(id)))];
              if (creatorIds.length === 0) return credits.map(c => ({ ...c.toJSON(), creator: null }));

              const creators = await Creator.findAll({
                where: { id: { [Op.in]: creatorIds } },
              });

              const creatorsById = creators.reduce((acc, c) => {
                acc[c.id] = c;
                return acc;
              }, {} as Record<number, typeof creators[0]>);

              return credits.map(credit => ({
                ...credit.toJSON(),
                creator: creatorsById[credit.creatorId] || null
              }));
            }) : Promise.resolve([]),
            level.teamId ? Team.findOne({
              where: { id: level.teamId },
            }) : Promise.resolve(null)
          ]);

          return {
            ...level.toJSON(),
            difficulty,
            levelCredits,
            teamObject: team
          };
        }),
        // Judgement query
        Judgement.findOne({
          where: { id: passId },
        })
      ]);

      if (!player || !level) {
        return res.json({count: 0, results: []});
      }

      const assembledPass = {
        ...pass.toJSON(),
        player,
        level,
        judgements: judgement || null
      };

      return res.json({count: 1, results: [assembledPass]});
    }
    catch (error) {
      logger.error('Error fetching pass by ID:', error);
      return res.status(500).json({error: 'Failed to fetch pass'});
    }
  },
);

router.get('/:id([0-9]{1,20})', Auth.addUserToRequest(), async (req: Request, res: Response) => {
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

router.get('/level/:levelId([0-9]{1,20})', Auth.addUserToRequest(), async (req: Request, res: Response) => {
    try {
      const {levelId} = req.params;
      const level = await Level.findByPk(levelId);
      if (!level || (level.isDeleted || level.isHidden) && (!req.user || !hasFlag(req.user, permissionFlags.SUPER_ADMIN))) {
        return res.status(404).json({error: 'Level not found'});
      }
      
      const parsedLevelId = parseInt(levelId);
      
      // Fetch passes
      const passesPromise = Pass.findAll({
        where: {
          levelId: parsedLevelId,
          isDeleted: false,
        },
      }).then(async (passes) => {
        if (passes.length === 0) return [];

        const playerIds = [...new Set(passes.map(p => p.playerId).filter((id): id is number => Boolean(id)))];
        const passIds = passes.map(p => p.id);

        // Fetch players and judgements concurrently
        const [players, judgements] = await Promise.all([
          playerIds.length > 0 ? Player.findAll({
            where: {
              id: { [Op.in]: playerIds },
              isBanned: false
            },
            include: [{
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
            }],
          }) : Promise.resolve([]),
          passIds.length > 0 ? Judgement.findAll({
            where: { id: { [Op.in]: passIds } },
          }) : Promise.resolve([])
        ]);

        const playersById = players.reduce((acc, p) => {
          acc[p.id] = p;
          return acc;
        }, {} as Record<number, typeof players[0]>);

        const judgementsByPassId = judgements.reduce((acc, j) => {
          acc[j.id] = j;
          return acc;
        }, {} as Record<number, typeof judgements[0]>);

        // Assemble passes with nested data and filter out passes with null players
        return passes
          .map(pass => {
            const player = pass.playerId ? playersById[pass.playerId] : null;
            return {
              ...pass.toJSON(),
              player: player || null,
              judgements: judgementsByPassId[pass.id] || null
            };
          })
          .filter(pass => pass.player !== null && pass.judgements !== null);
      });

      const passes = await passesPromise;

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
