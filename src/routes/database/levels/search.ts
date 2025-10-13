import { Router, Request, Response } from 'express';
import { Auth } from '../../../middleware/auth.js';
import Difficulty from '../../../models/levels/Difficulty.js';
import Level from '../../../models/levels/Level.js';
import Pass from '../../../models/passes/Pass.js';
import LevelCredit from '../../../models/levels/LevelCredit.js';
import Team from '../../../models/credits/Team.js';
import Creator from '../../../models/credits/Creator.js';
import LevelAlias from '../../../models/levels/LevelAlias.js';
import sequelize from '../../../config/db.js';
import { Op, Transaction } from 'sequelize';
import Player from '../../../models/players/Player.js';
import Judgement from '../../../models/passes/Judgement.js';
import { CreatorAlias } from '../../../models/credits/CreatorAlias.js';
import RatingDetail from '../../../models/levels/RatingDetail.js';
import Rating from '../../../models/levels/Rating.js';
import LevelLikes from '../../../models/levels/LevelLikes.js';
import { User } from '../../../models/index.js';
import RatingAccuracyVote from '../../../models/levels/RatingAccuracyVote.js';
import { logger } from '../../../services/LoggerService.js';
import ElasticsearchService from '../../../services/ElasticsearchService.js';
import LevelRerateHistory from '../../../models/levels/LevelRerateHistory.js';
import { safeTransactionRollback } from '../../../utils/Utility.js';
import Curation from '../../../models/curations/Curation.js';
import CurationType from '../../../models/curations/CurationType.js';
import { hasFlag } from '../../../utils/permissionUtils.js';
import { permissionFlags } from '../../../config/constants.js';

const MAX_LIMIT = 200;

const router: Router = Router()
const elasticsearchService = ElasticsearchService.getInstance();

router.get('/', Auth.addUserToRequest(), async (req: Request, res: Response) => {
  try {
    const {
      query,
      pguRange,
      specialDifficulties,
      sort,
      offset = 0,
      limit = 30,
      deletedFilter,
      clearedFilter,
      availableDlFilter,
      curatedTypesFilter,
      onlyMyLikes,
    } = req.query;

    const startTime = Date.now();
    // Normalize pagination parameters
    const normalizedLimit = Math.min(Math.max(Number(limit), 1), MAX_LIMIT);
    const normalizedOffset = Math.max(Number(offset), 0);

    // Parse pguRange from comma-separated string
    let parsedPguRange;
    if (pguRange) {
      const [from, to] = (pguRange as string).split(',').map(s => s.trim());
      parsedPguRange = { from, to };
    }

    // Parse specialDifficulties from string
    let parsedSpecialDifficulties;
    if (specialDifficulties) {
        parsedSpecialDifficulties = (specialDifficulties as string).split(',').map(s => s.trim());
    }

    // Get liked level IDs if needed
    let likedLevelIds;
    if (onlyMyLikes === 'true' && req.user?.id) {
      likedLevelIds = await LevelLikes.findAll({
        where: { userId: req.user.id },
        attributes: ['levelId']
      }).then(likes => likes.map(l => l.levelId));
      //logger.info('Liked level IDs:', likedLevelIds);
    }

    // Search using Elasticsearch
    const { hits, total } = await elasticsearchService.searchLevels(
      query as string,
      {
        pguRange: parsedPguRange,
        specialDifficulties: parsedSpecialDifficulties,
        sort: sort as string,
        deletedFilter: deletedFilter as string,
        clearedFilter: clearedFilter as string,
        availableDlFilter: availableDlFilter as string,
        curatedTypesFilter: curatedTypesFilter as string,
        userId: req.user?.id,
        offset: normalizedOffset,
        limit: normalizedLimit,
        likedLevelIds
      }
    );

    const duration = Date.now() - startTime;
    if (duration > 1000) {
      logger.debug(`[Levels] Search for ${query} completed in ${duration}ms with ${total} results`);
    }

    res.json({
      results: hits || [],
      hasMore: normalizedOffset + normalizedLimit < total,
      total
    });
  } catch (error) {
    logger.error('Error in level search:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/byId/:id([0-9]+)', Auth.addUserToRequest(), async (req: Request, res: Response) => {
  try {
    const levelId = parseInt(req.params.id);

  // Check if levelId is not a valid number
  if (isNaN(levelId) || !Number.isInteger(levelId) || levelId <= 0) {
    return res.status(400).json({error: 'Invalid level ID'});
  }

  const level = await Level.findOne({
    where: { id: levelId },
    include: [
      {
        model: Difficulty,
        as: 'difficulty',
        required: false,
      },
      {
        model: Pass,
        as: 'passes',
        required: false,
        attributes: ['id'],
      },
      {
        model: LevelCredit,
        as: 'levelCredits',
        required: false,
        include: [
          {
            model: Creator,
            as: 'creator',
          },
        ],
      },
      {
        model: LevelAlias,
        as: 'aliases',
        required: false,
      },
      {
        model: Team,
        as: 'teamObject',
        required: false,
      }
    ],
  });

  if (!level) {
    return res.status(404).json({ error: 'Level not found' });
  }

  // If level is deleted and user is not super admin, return 404
  if (level.isDeleted && (!req.user || !hasFlag(req.user, permissionFlags.SUPER_ADMIN))) {
    return res.status(404).json({ error: 'Level not found' });
  }

    return res.json(level);
  } catch (error) {
    logger.error(`Error fetching level by ID ${req.params.id}:`, (error instanceof Error ? error.toString() : String(error)).slice(0, 1000));
    return res.status(500).json({ error: 'Failed to fetch level by ID' });
  }
});

// Add HEAD endpoint for byId permission check
router.head('/byId/:id([0-9]+)', Auth.addUserToRequest(), async (req: Request, res: Response) => {
  try {
    const levelId = parseInt(req.params.id);

    if (isNaN(levelId)) {
      return res.status(400).end();
    }

    const level = await Level.findOne({
      where: { id: levelId },
      attributes: ['isDeleted']
    });

    if (!level) {
      return res.status(404).end();
    }

    // If level is deleted and user is not super admin, return 403
    if (level.isDeleted && (!req.user || !hasFlag(req.user, permissionFlags.SUPER_ADMIN))) {
      return res.status(404).end();
    }

    return res.status(200).end();
  } catch (error) {
    logger.error('Error checking level permissions:', error);
    return res.status(500).end();
  }
});

router.get('/:id([0-9]+)', Auth.addUserToRequest(), async (req: Request, res: Response) => {
  try {
    const includeRatings = req.query.includeRatings === 'true';
    // Use a READ COMMITTED transaction to avoid locks from updates
    if (!req.params.id || isNaN(parseInt(req.params.id)) || parseInt(req.params.id) <= 0) {
      return res.status(400).json({ error: 'Invalid level ID' });
    }
    const transaction = await sequelize.transaction({
      isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED,
    });

    try {
      const level = await Level.findOne({
        where: { id: parseInt(req.params.id) },
        include: [
          {
            model: Pass,
            as: 'passes',
            required: false,
            include: [
              {
                model: Player,
                as: 'player',
                where: {
                  isBanned: false
                }
              },
              {
                model: Judgement,
                as: 'judgements',
              },
            ],
            where: {
              isDeleted: false,
              isHidden: false
            }
          },
          {
            model: Difficulty,
            as: 'difficulty',
          },
          {
            model: LevelAlias,
            as: 'aliases',
            required: false,
          },
          {
            model: LevelCredit,
            as: 'levelCredits',
            required: false,
            include: [
              {
                model: Creator,
                as: 'creator',
                include: [
                  {
                    model: CreatorAlias,
                    as: 'creatorAliases',
                    attributes: ['name'],
                  },
                ],
              },
            ],
          },
          {
            model: Team,
            as: 'teamObject',
            required: false,
          },
          {
            model: Curation,
            as: 'curation',
            required: false,
            include: [
              {
                model: CurationType,
                as: 'type',
              },
              {
                model: User,
                as: 'assignedByUser',
                attributes: ['nickname','username', 'avatarUrl'],
              },
            ],
          },
        ],
        transaction,
      });

      const ratings = await Rating.findOne({
        where: {
          levelId: parseInt(req.params.id),
          [Op.not]: {confirmedAt: null}
        },
        include: [
          {
            model: RatingDetail,
            as: 'details',
            include: [
              {
                model: User,
                as: 'user',
                attributes: ['username', 'avatarUrl'],
              },
            ],
          },
        ],
        order: [['confirmedAt', 'DESC']],
        transaction,
      });

      const votes = await RatingAccuracyVote.findAll({
        where: {
          levelId: parseInt(req.params.id),
          diffId: level?.difficulty?.id || 0
        },
        include: [
          {
            model: User,
            as: 'user',
            attributes: ['username', 'avatarUrl'],
            include: [
              {
                model: Player,
                as: 'player',
                attributes: ['name'],
              },
            ],
          },
        ],
      });

      const totalVotes = votes.length;

      const isLiked = req.user ? !!(await LevelLikes.findOne({
        where: { levelId: parseInt(req.params.id), userId: req.user?.id },
      })) : false;

      const isCleared = req.user?.playerId ? !!(await Pass.findOne({
        where: { levelId: parseInt(req.params.id), playerId: req.user?.playerId },
      })) : false;

      const rerateHistory = await LevelRerateHistory.findAll({
        where: { levelId: parseInt(req.params.id) },
        order: [['createdAt', 'DESC']],
      });

      await transaction.commit();


      if (!level) {
        return res.status(404).json({ error: 'Level not found' });
      }

      // If level is deleted and user is not super admin, return 404
      if (level.isDeleted && (!req.user || !hasFlag(req.user, permissionFlags.SUPER_ADMIN))) {
        return res.status(404).json({ error: 'Level not found' });
      }


      return res.json({
        level,
        ratings: includeRatings ? ratings : undefined,
        votes: req.user && hasFlag(req.user, permissionFlags.SUPER_ADMIN) ? votes : undefined,
        rerateHistory,
        totalVotes,
        isLiked,
        isCleared,
      });
    } catch (error) {
      await safeTransactionRollback(transaction);
      throw error;
    }
  } catch (error) {
    logger.error('Error fetching level:', error);
    return res.status(500).json({ error: 'Failed to fetch level' });
  }
});

export default router;
