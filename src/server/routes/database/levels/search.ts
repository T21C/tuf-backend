import { Router, Request, Response } from 'express';
import { Auth } from '../../../middleware/auth.js';
import Difficulty from '../../../../models/levels/Difficulty.js';
import Level from '../../../../models/levels/Level.js';
import Pass from '../../../../models/passes/Pass.js';
import LevelCredit from '../../../../models/levels/LevelCredit.js';
import Team from '../../../../models/credits/Team.js';
import Creator from '../../../../models/credits/Creator.js';
import LevelAlias from '../../../../models/levels/LevelAlias.js';
import sequelize from '../../../../config/db.js';
import { Op, Transaction, where } from 'sequelize';
import Player from '../../../../models/players/Player.js';
import Judgement from '../../../../models/passes/Judgement.js';
import { CreatorAlias } from '../../../../models/credits/CreatorAlias.js';
import RatingDetail from '../../../../models/levels/RatingDetail.js';
import Rating from '../../../../models/levels/Rating.js';
import LevelLikes from '../../../../models/levels/LevelLikes.js';
import { User } from '../../../../models/index.js';
import { logger } from '../../../services/LoggerService.js';
import ElasticsearchService from '../../../services/ElasticsearchService.js';
import LevelRerateHistory from '../../../../models/levels/LevelRerateHistory.js';
import { safeTransactionRollback } from '../../../../misc/utils/Utility.js';
import Curation from '../../../../models/curations/Curation.js';
import CurationType from '../../../../models/curations/CurationType.js';
import LevelTag from '../../../../models/levels/LevelTag.js';
import { hasFlag } from '../../../../misc/utils/auth/permissionUtils.js';
import { permissionFlags } from '../../../../config/constants.js';
import cdnService from '../../../services/CdnService.js';
import CurationSchedule from '../../../../models/curations/CurationSchedule.js';
import Song from '../../../../models/songs/Song.js';
import SongAlias from '../../../../models/songs/SongAlias.js';
import Artist from '../../../../models/artists/Artist.js';
import { getArtistDisplayName, getSongDisplayName } from '../../../../utils/levelHelpers.js';
import { Cache } from '../../../middleware/cache.js';


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
      tagsFilter,
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

    // Group tags by their group field if tagsFilter is provided
    let tagGroups: { [groupKey: string]: number[] } | undefined;
    if (tagsFilter && tagsFilter !== 'show') {
      const tagNames = (tagsFilter as string).split(',').map(s => s.trim());
      if (tagNames.length > 0) {
        const tags = await LevelTag.findAll({
          where: {
            name: { [Op.in]: tagNames }
          },
          attributes: ['id', 'name', 'group']
        });

        // Group tags by their group field (use empty string for null/undefined groups)
        tagGroups = tags.reduce((groups, tag) => {
          const groupKey = tag.group || '';
          if (!groups[groupKey]) {
            groups[groupKey] = [];
          }
          groups[groupKey].push(tag.id);
          return groups;
        }, {} as { [groupKey: string]: number[] });
      }
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
        tagsFilter: tagsFilter as string,
        tagGroups,
        userId: req.user?.id,
        creatorId: req.user?.creatorId,
        offset: normalizedOffset,
        limit: normalizedLimit,
        likedLevelIds
      },
      hasFlag(req.user, permissionFlags.SUPER_ADMIN)
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

router.get('/byId/:id([0-9]{1,20})', Auth.addUserToRequest(), Cache({
  ttl: 300, // 5 minutes
  varyByRole: true, // Different cache for admin vs regular users (due to isDeleted check)
  tags: (req) => [`level:${req.params.id}`, 'levels:all']
}), async (req: Request, res: Response) => {
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
      },
      {
        model: LevelTag,
        as: 'tags',
        required: false,
        through: {
          attributes: []
        }
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
router.head('/byId/:id([0-9]{1,20})', Auth.addUserToRequest(), async (req: Request, res: Response) => {
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

router.get('/:id([0-9]{1,20})', Auth.addUserToRequest(), Cache({
  ttl: 60*60*24, 
  varyByRole: true, // isliked checked in other endpoint
  tags: (req) => [`level:${req.params.id}`, 'levels:all']
}), async (req: Request, res: Response) => {
  try {
    if (!req.params.id || isNaN(parseInt(req.params.id)) || parseInt(req.params.id) <= 0) {
      return res.status(400).json({ error: 'Invalid level ID' });
    }
    const levelId = parseInt(req.params.id);
    const transaction = await sequelize.transaction({
      isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED,
    });

    try {
      // Base level query (minimal data) with normalized song/artist
      const levelPromise = Level.findOne({
        where: { id: levelId },
        include: [
          {
            model: Song,
            as: 'songObject',
            include: [
              {
                model: SongAlias,
                as: 'aliases',
                attributes: ['id', 'alias']
              },
              {
                model: Artist,
                as: 'artists',
                attributes: ['id', 'name', 'avatarUrl']
              }
            ],
            required: false
          },
        ],
        transaction,
      });

      // Difficulty query (needs level's diffId)
      const difficultyPromise = levelPromise.then(async (level) => {
        if (!level) return null;
        return Difficulty.findOne({
          where: { id: level.diffId },
          transaction,
        });
      });

      // Passes query with nested Player, User, and Judgement
      const passesPromise = Pass.findAll({
        where: {
          levelId: levelId,
          isDeleted: false,
          isHidden: false
        },
        transaction,
      }).then(async (passes) => {
        if (passes.length === 0) return [];

        const playerIds = passes.map(p => p.playerId).filter(Boolean);
        const playersPromise = Player.findAll({
          where: {
            id: { [Op.in]: playerIds },
            isBanned: false
          },
          include: [
            {
              model: User,
              as: 'user',
              required: false,
              attributes: ['avatarUrl', 'username'],
            },
          ],
          transaction,
        });

        const judgementsPromise = Judgement.findAll({
          where: {
            id: { [Op.in]: passes.map(p => p.id) }
          },
          transaction,
        });

        const [players, judgements] = await Promise.all([playersPromise, judgementsPromise]);

        // Map judgements by id (Judgement.id = Pass.id, one-to-one relationship)
        const judgementsByPassId = judgements.reduce((acc, j) => {
          acc[j.id] = j;
          return acc;
        }, {} as Record<number, typeof judgements[0]>);

        // Group players by id
        const playersById = players.reduce((acc, p) => {
          acc[p.id] = p;
          return acc;
        }, {} as Record<number, typeof players[0]>);

        // Assemble passes with nested data and filter out passes with null players (banned players or missing playerId)
        return passes
          .map(pass => {
            const player = pass.playerId ? playersById[pass.playerId] : null;
            return {
              ...pass.toJSON(),
              player: player || null,
              judgements: judgementsByPassId[pass.id] || null
            };
          })
          .filter(pass => pass.player !== null); // Exclude passes where player is null (banned or missing playerId)
      });

      // LevelAlias query
      const aliasesPromise = LevelAlias.findAll({
        where: { levelId: levelId },
        transaction,
      });

      // LevelCredit query with nested Creator and CreatorAlias
      const levelCreditsPromise = LevelCredit.findAll({
        where: { levelId: levelId },
        transaction,
      }).then(async (credits) => {
        if (credits.length === 0) return [];

        const creatorIds = credits.map(c => c.creatorId).filter(Boolean);
        const creatorsPromise = Creator.findAll({
          where: {
            id: { [Op.in]: creatorIds }
          },
          attributes: ['id', 'name', 'userId', 'isVerified'],
          include: [
            {
              model: CreatorAlias,
              as: 'creatorAliases',
              attributes: ['name'],
            },
          ],
          transaction,
        });

        const creators = await creatorsPromise;
        const creatorsById = creators.reduce((acc, c) => {
          acc[c.id] = c;
          return acc;
        }, {} as Record<number, typeof creators[0]>);

        return credits.map(credit => ({
          ...credit.toJSON(),
          creator: creatorsById[credit.creatorId] || null
        }));
      });

      // Team query
      const teamPromise = levelPromise.then(async (level) => {
        if (!level?.teamId) return null;
        return Team.findOne({
          where: { id: level.teamId },
          transaction,
        });
      });

      // Curation query with nested CurationType and User
      const curationPromise = Curation.findOne({
        where: { levelId: levelId },
        include: [
          {
            model: CurationType,
            as: 'type',
          },
          {
            model: CurationSchedule,
            as: 'curationSchedules',
            where: { weekStart: { [Op.lte]: new Date() }},
            required: false,
          },
          {
            model: User,
            as: 'assignedByUser',
            attributes: ['nickname','username', 'avatarUrl'],
          },
        ],
        transaction,
      });

      // Rating query
      const ratingsPromise = Rating.findOne({
        where: {
          levelId: levelId,
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

      // LevelRerateHistory query
      const rerateHistoryPromise = LevelRerateHistory.findAll({
        where: { levelId: levelId },
        order: [['createdAt', 'DESC']],
        transaction,
      });

      // Tags query
      const tagsPromise = LevelTag.findAll({
        where: {
          id: {
            [Op.in]: sequelize.literal(`(
              SELECT tagId FROM level_tag_assignments WHERE levelId = ${levelId}
            )`)
          }
        },
        order: [['name', 'ASC']],
        transaction,
      });

      // CDN service calls (need level data)
      const cdnDataPromise = levelPromise.then(async (level) => {
        if (!level?.dlLink) return { bpm: undefined, tilecount: undefined, accessCount: 0 };

        try {
          const fileResponse = await cdnService.getLevelData(level, ['settings','tilecount','accessCount']);
          return {
            bpm: fileResponse?.settings?.bpm,
            tilecount: fileResponse?.tilecount,
            accessCount: fileResponse?.accessCount || 0
          };
        } catch (error) {
          logger.debug('Level metadata retrieval error for level:', {levelId: req.params.id, error: error instanceof Error ? error.toString() : String(error)});
          return { bpm: undefined, tilecount: undefined, accessCount: 0 };
        }
      });

      const metadataPromise = levelPromise.then(async (level) => {
        if (!level) return undefined;
        try {
          return (await cdnService.getLevelMetadata(level))?.metadata || undefined;
        } catch (error) {
          logger.debug('Level file metadata retrieval error for level:', {levelId: req.params.id, error: error instanceof Error ? error.toString() : String(error)});
          return undefined;
        }
      });

      // Execute all queries concurrently
      const [
        level,
        difficulty,
        passes,
        aliases,
        levelCredits,
        teamObject,
        curation,
        ratings,
        rerateHistory,
        tags,
        cdnData,
        metadata
      ] = await Promise.all([
        levelPromise,
        difficultyPromise,
        passesPromise,
        aliasesPromise,
        levelCreditsPromise,
        teamPromise,
        curationPromise,
        ratingsPromise,
        rerateHistoryPromise,
        tagsPromise,
        cdnDataPromise,
        metadataPromise
      ]);

      await transaction.commit();

      if (!level) {
        return res.status(404).json({ error: 'Level not found' });
      }

      // If level is deleted and user is not super admin, return 404
      if (level.isDeleted && (!req.user || !hasFlag(req.user, permissionFlags.SUPER_ADMIN))) {
        return res.status(404).json({ error: 'Level not found' });
      }

      // Assemble the level object with all related data
      const assembledLevel = {
        ...level.toJSON(),
        difficulty,
        passes,
        aliases,
        levelCredits,
        teamObject,
        curation,
        tags: tags || [],
        song: getSongDisplayName(level),
        artist: getArtistDisplayName(level) || null
      };

      return res.json({
        level: assembledLevel,
        ratings,
        rerateHistory,
        bpm: cdnData.bpm,
        tilecount: cdnData.tilecount,
        accessCount: cdnData.accessCount,
        metadata,
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

router.get('/:id([0-9]{1,20})/isLiked', Auth.addUserToRequest(), Cache({
  ttl: 300,
  varyByUser: true, // User-specific, so must vary by user
  tags: (req) => [`level:${req.params.id}:isLiked`, 'levels:all']
}), async (req: Request, res: Response) => {
  try {
    const levelId = parseInt(req.params.id);
    
    const likes = await LevelLikes.count({
      where: { levelId: levelId },
    });
    
    if (!req.user?.id) {
      return res.json({ isLiked: false, likes });
    }
    
    const isLiked = await LevelLikes.findOne({
      where: { levelId: levelId, userId: req.user.id },
    });
    return res.json({ isLiked: !!isLiked, likes });
  } catch (error) {
    logger.error('Error checking if level is liked:', error);
    return res.status(500).json({ error: 'Failed to check if level is liked' });
  }
});

router.get('/:id([0-9]{1,20})/level.adofai', Auth.addUserToRequest(), async (req: Request, res: Response) => {
  try {
    const levelId = parseInt(req.params.id);
    const level = await Level.findOne({
      where: { id: levelId },
    });
    if (!level) {
      return res.status(404).json({ error: 'Level not found' });
    }
    const metadata = await cdnService.getLevelAdofai(level);
    return res.json(metadata);
  }
  catch (error) {
    logger.error('Error fetching level.adofai:', error);
    return res.status(500).json({ error: 'Failed to fetch level.adofai' });
  }
});

export default router;
