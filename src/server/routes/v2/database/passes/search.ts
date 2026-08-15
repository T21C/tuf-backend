import { Router, Request, Response } from 'express';
import { Auth } from '@/server/middleware/auth.js';
import { ApiDoc } from '@/server/middleware/apiDoc.js';
import { standardErrorResponses404500, standardErrorResponses500, idParamSpec } from '@/server/schemas/v2/database/passes/index.js';
import { Op } from 'sequelize';
import Pass from '@/models/passes/Pass.js';
import Player from '@/models/players/Player.js';
import Level from '@/models/levels/Level.js';
import Judgement from '@/models/passes/Judgement.js';
import Difficulty from '@/models/levels/Difficulty.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { PlayerStatsService } from '@/server/services/core/PlayerStatsService.js';
import { User } from '@/models/index.js';
import { searchPasses } from './index.js';
import { ensureString } from '@/misc/utils/Utility.js';
import { hasFlag, wherePermission } from '@/misc/utils/auth/permissionUtils.js';
import { permissionFlags } from '@/config/constants.js';
import Creator from '@/models/credits/Creator.js';
import LevelCredit from '@/models/levels/LevelCredit.js';
import Team from '@/models/credits/Team.js';
import { PaginationQuery } from '@/server/interfaces/models/index.js';
import {
  isRandomSortParam,
  resolveSearchSeed,
} from '@/server/services/elasticsearch/search/tools/seededRandomSort.js';

const playerStatsService = PlayerStatsService.getInstance();
const router = Router();


router.get(
  '/byId/:id([0-9]{1,20})',
  Auth.addUserToRequest(),
  ApiDoc({
    operationId: 'getPassById',
    summary: 'Get pass by ID (byId)',
    description: 'Fetch a single pass by numeric ID with player, level, and judgements. Super admins see deleted passes.',
    tags: ['Passes'],
    security: ['bearerAuth'],
    params: { id: { description: 'Pass ID', schema: { type: 'string' } } },
    responses: { 200: { description: 'Pass with count and results array' }, ...standardErrorResponses404500 },
  }),
  async (req: Request, res: Response) => {
    try {
    const passId = parseInt(req.params.id);
      if (!passId || isNaN(passId) || passId <= 0) {
        return res.status(400).json({error: 'Invalid pass ID'});
      }
      const user = req.user;

      // Base pass query
      const whereClause: any = {
        id: passId,
      };

      // For non-super-admins, filter deleted passes
      if (!user || !hasFlag(user, permissionFlags.SUPER_ADMIN)) {
        whereClause.isDeleted = false;
        whereClause.isHidden = false;
      }

      const pass = await Pass.findOne({ where: whereClause });

      if (!pass) {
        return res.json({count: 0, results: []});
      }

      // Check if pass is hidden and user is not the owner
      if (pass.isHidden && (!user || !user.playerId || pass.playerId !== user.playerId)) {
        // If user is not a super admin and doesn't own the pass, don't show it
        if (!user || !hasFlag(user, permissionFlags.SUPER_ADMIN)) {
          return res.json({count: 0, results: []});
        }
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
            attributes: [
              'id',
              'username',
              'nickname',
              'avatarUrl',
              'isSuperAdmin',
              'isRater',
            ],
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

router.get(
  '/:id([0-9]{1,20})',
  Auth.addUserToRequest(),
  ApiDoc({
    operationId: 'getPassDetails',
    summary: 'Get pass details by ID',
    description: 'Fetch pass by ID with full details via PlayerStatsService. Returns 404 for missing or hidden (non-owner).',
    tags: ['Passes'],
    security: ['bearerAuth'],
    params: { id: idParamSpec },
    responses: { 200: { description: 'Pass details' }, 404: { description: 'Pass not found' }, ...standardErrorResponses500 },
  }),
  async (req: Request, res: Response) => {
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
  },
);

router.get(
  '/level/:levelId([0-9]{1,20})/placement',
  Auth.addUserToRequest(),
  ApiDoc({
    operationId: 'getPassPlacementByLevelId',
    summary: 'Level leaderboard placement for a score',
    description:
      'Cheap best-per-player rank: how many players have a higher max scoreV2 on this level. Matches level-page dedupe.',
    tags: ['Passes'],
    security: ['bearerAuth'],
    params: { levelId: { description: 'Level ID', schema: { type: 'string' } } },
    query: {
      score: { description: 'Simulated scoreV2', schema: { type: 'string' } },
    },
    responses: {
      200: { description: '{ rank, total, tied }' },
      404: { description: 'Level not found' },
      ...standardErrorResponses500,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const levelId = parseInt(req.params.levelId, 10);
      const score = Number(req.query.score);
      if (!Number.isFinite(levelId) || levelId <= 0) {
        return res.status(400).json({ error: 'Invalid level ID' });
      }
      if (!Number.isFinite(score)) {
        return res.status(400).json({ error: 'Invalid score' });
      }

      const level = await Level.findByPk(levelId);
      if (
        !level ||
        ((level.isDeleted || level.isHidden) &&
          (!req.user || !hasFlag(req.user, permissionFlags.SUPER_ADMIN)))
      ) {
        return res.status(404).json({ error: 'Level not found' });
      }

      const sequelize = Pass.sequelize!;
      const [rows] = (await sequelize.query(
        `
        SELECT
          (SELECT COUNT(*) FROM (
            SELECT playerId FROM passes
            WHERE levelId = :levelId AND IFNULL(isDeleted, 0) = 0 AND IFNULL(isHidden, 0) = 0
              AND playerId IS NOT NULL
            GROUP BY playerId
          ) t) AS total,
          (SELECT COUNT(*) FROM (
            SELECT playerId, MAX(scoreV2) AS best
            FROM passes
            WHERE levelId = :levelId AND IFNULL(isDeleted, 0) = 0 AND IFNULL(isHidden, 0) = 0
              AND playerId IS NOT NULL
            GROUP BY playerId
          ) bests WHERE best > :score) AS better,
          (SELECT COUNT(*) FROM (
            SELECT playerId, MAX(scoreV2) AS best
            FROM passes
            WHERE levelId = :levelId AND IFNULL(isDeleted, 0) = 0 AND IFNULL(isHidden, 0) = 0
              AND playerId IS NOT NULL
            GROUP BY playerId
          ) ties WHERE ABS(best - :score) < 0.005) AS tied
        `,
        { replacements: { levelId, score } },
      )) as [{ total: number; better: number; tied: number }[], unknown];

      const row = Array.isArray(rows) ? rows[0] : null;
      const total = Number(row?.total) || 0;
      const better = Number(row?.better) || 0;
      const tied = Number(row?.tied) || 0;
      return res.json({
        rank: better + 1,
        total,
        tied,
      });
    } catch (error) {
      logger.error('Error computing pass placement:', error);
      return res.status(500).json({ error: 'Failed to compute placement' });
    }
  },
);

router.get(
  '/level/:levelId([0-9]{1,20})/calculator-player',
  Auth.addUserToRequest(),
  ApiDoc({
    operationId: 'getPassCalculatorPlayerContext',
    summary: 'Player context for pass score calculator',
    description:
      'Best pass on this level for a player, plus their top-20 best-per-level scores for ranked impact preview.',
    tags: ['Passes'],
    security: ['bearerAuth'],
    params: { levelId: { description: 'Level ID', schema: { type: 'string' } } },
    query: {
      playerId: { description: 'Player ID', schema: { type: 'string' } },
    },
    responses: {
      200: { description: '{ bestOnLevel, top20 }' },
      404: { description: 'Level or player not found' },
      ...standardErrorResponses500,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const levelId = parseInt(req.params.levelId, 10);
      const playerId = parseInt(String(req.query.playerId), 10);
      if (!Number.isFinite(levelId) || levelId <= 0) {
        return res.status(400).json({ error: 'Invalid level ID' });
      }
      if (!Number.isFinite(playerId) || playerId <= 0) {
        return res.status(400).json({ error: 'Invalid player ID' });
      }

      const level = await Level.findByPk(levelId);
      if (
        !level ||
        ((level.isDeleted || level.isHidden) &&
          (!req.user || !hasFlag(req.user, permissionFlags.SUPER_ADMIN)))
      ) {
        return res.status(404).json({ error: 'Level not found' });
      }

      const player = await Player.findByPk(playerId);
      if (!player || player.isBanned) {
        return res.status(404).json({ error: 'Player not found' });
      }

      const bestOnLevel = await Pass.findOne({
        where: {
          levelId,
          playerId,
          isDeleted: false,
          isHidden: false,
        },
        attributes: ['id', 'scoreV2', 'levelId'],
        order: [
          ['scoreV2', 'DESC'],
          ['id', 'DESC'],
        ],
      });

      const sequelize = Pass.sequelize!;
      const [topRows] = (await sequelize.query(
        `
        SELECT b.levelId, b.scoreV2
        FROM (
          SELECT p.levelId, MAX(p.scoreV2) AS scoreV2
          FROM passes p
          INNER JOIN levels l ON l.id = p.levelId AND IFNULL(l.isDeleted, 0) = 0
          WHERE p.playerId = :playerId
            AND IFNULL(p.isDeleted, 0) = 0
            AND IFNULL(p.isHidden, 0) = 0
            AND IFNULL(p.isDuplicate, 0) = 0
            AND (
              IFNULL(l.isExternallyAvailable, 0) = 1
              OR (l.dlLink IS NOT NULL AND l.dlLink != '')
              OR (l.workshopLink IS NOT NULL AND l.workshopLink != '')
            )
          GROUP BY p.levelId
        ) b
        ORDER BY b.scoreV2 DESC
        LIMIT 20
        `,
        { replacements: { playerId } },
      )) as [{ levelId: number; scoreV2: number }[], unknown];

      return res.json({
        bestOnLevel: bestOnLevel
          ? {
              id: bestOnLevel.id,
              scoreV2: bestOnLevel.scoreV2,
              levelId: bestOnLevel.levelId,
            }
          : null,
        top20: (Array.isArray(topRows) ? topRows : []).map((r) => ({
          levelId: Number(r.levelId),
          scoreV2: Number(r.scoreV2) || 0,
        })),
      });
    } catch (error) {
      logger.error('Error fetching calculator player context:', error);
      return res.status(500).json({ error: 'Failed to fetch player context' });
    }
  },
);

router.get(
  '/level/:levelId([0-9]{1,20})',
  Auth.addUserToRequest(),
  ApiDoc({
    operationId: 'getPassesByLevelId',
    summary: 'Get passes by level ID',
    description: 'List all non-deleted passes for a level with players and judgements. Hidden passes visible only to owner or super admin.',
    tags: ['Passes'],
    security: ['bearerAuth'],
    params: { levelId: { description: 'Level ID', schema: { type: 'string' } } },
    responses: { 200: { description: 'Array of passes' }, 404: { description: 'Level not found' }, ...standardErrorResponses500 },
  }),
  async (req: Request, res: Response) => {
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
          isHidden: false,
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
        const userPlayerId = req.user?.playerId;
        const isSuperAdmin = req.user && hasFlag(req.user, permissionFlags.SUPER_ADMIN);

        return passes
          .map(pass => {
            const player = pass.playerId ? playersById[pass.playerId] : null;
            return {
              ...pass.toJSON(),
              player: player || null,
              judgements: judgementsByPassId[pass.id] || null
            };
          })
          .filter(pass => {
            // Filter out passes with null players or judgements
            if (pass.player === null || pass.judgements === null) {
              return false;
            }

            // Filter out hidden passes unless user is the owner or super admin
            if (pass.isHidden) {
              if (isSuperAdmin) {
                return true; // Super admins can see all passes
              }
              if (userPlayerId && pass.player?.id === userPlayerId) {
                return true; // Users can see their own hidden passes
              }
              return false; // Hidden passes are not visible to others
            }

            return true;
          });
      });

      const passes = await passesPromise;

      return res.json(passes);
    } catch (error) {
      logger.error('Error fetching passes:', error);
      return res.status(500).json({error: 'Failed to fetch passes'});
    }
  },
);

router.get(
  '/',
  Auth.addUserToRequest(),
  ApiDoc({
    operationId: 'searchPasses',
    summary: 'Search passes',
    description: 'Search passes with filters (query, deletedFilter, minDiff, maxDiff, keyFlag, wfFilter, levelId, player, specialDifficulties, sort). Query: page, offset, limit. Uses Elasticsearch.',
    tags: ['Passes'],
    security: ['bearerAuth'],
    query: {
      query: { description: 'Search text', schema: { type: 'string' } },
      deletedFilter: { schema: { type: 'string' } },
      minDiff: { schema: { type: 'string' } },
      maxDiff: { schema: { type: 'string' } },
      keyFlag: { schema: { type: 'string' } },
      wfFilter: { schema: { type: 'string' } },
      levelId: { schema: { type: 'string' } },
      player: { schema: { type: 'string' } },
      specialDifficulties: { schema: { type: 'string' } },
      sort: { schema: { type: 'string' } },
      seed: { description: 'Seed for RANDOM sort (stable pagination). Generated when omitted.', schema: { type: 'integer' } },
      page: { schema: { type: 'string' } },
      offset: { schema: { type: 'string' } },
      limit: { schema: { type: 'string' } },
    },
    responses: { 200: { description: 'Paginated pass list (count, results)' }, ...standardErrorResponses500 },
  }),
  async (req: Request, res: Response) => {
    try {
      const { page, offset, limit } = req.query as unknown as PaginationQuery;
      const {
        deletedFilter,
        minDiff,
        maxDiff,
        keyFlag,
        wfFilter,
        levelId,
        player,
        specialDifficulties,
        query: searchQuery,
        sort,
        seed: seedQuery,
      } = req.query;

      // Get user's playerId if logged in
      const userPlayerId = req.user?.playerId;
      const sortStr = ensureString(sort);
      const seed = isRandomSortParam(sortStr) ? resolveSearchSeed(seedQuery) : undefined;

      const result = await searchPasses({
        deletedFilter: ensureString(deletedFilter),
        minDiff: ensureString(minDiff),
        maxDiff: ensureString(maxDiff),
        keyFlag: ensureString(keyFlag),
        wfFilter: ensureString(wfFilter),
        levelId: ensureString(levelId),
        player: ensureString(player),
        specialDifficulties,
        query: ensureString(searchQuery),
        offset,
        limit,
        sort: sortStr,
        seed,
      }, userPlayerId, hasFlag(req.user, permissionFlags.SUPER_ADMIN));

      return res.json({
        ...result,
        page,
        offset,
        limit,
        ...(seed !== undefined ? { seed } : {}),
      });
    } catch (error) {
      logger.error('Error fetching passes:', error);
      return res.status(500).json({error: 'Failed to fetch passes'});
    }
  },
);

export default router;
