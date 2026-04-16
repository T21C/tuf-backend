import { Router, Request, Response } from 'express';
import { Auth } from '@/server/middleware/auth.js';
import Difficulty from '@/models/levels/Difficulty.js';
import Level from '@/models/levels/Level.js';
import Pass from '@/models/passes/Pass.js';
import LevelCredit from '@/models/levels/LevelCredit.js';
import Team from '@/models/credits/Team.js';
import Creator from '@/models/credits/Creator.js';
import LevelAlias from '@/models/levels/LevelAlias.js';
import sequelize from '@/config/db.js';
import { Op } from 'sequelize';
import Player from '@/models/players/Player.js';
import Judgement from '@/models/passes/Judgement.js';
import { CreatorAlias } from '@/models/credits/CreatorAlias.js';
import RatingDetail from '@/models/levels/RatingDetail.js';
import Rating from '@/models/levels/Rating.js';
import LevelLikes from '@/models/levels/LevelLikes.js';
import { User } from '@/models/index.js';
import { logger } from '@/server/services/core/LoggerService.js';
import ElasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';
import LevelRerateHistory from '@/models/levels/LevelRerateHistory.js';
import Curation from '@/models/curations/Curation.js';
import CurationType from '@/models/curations/CurationType.js';
import LevelTag from '@/models/levels/LevelTag.js';
import { hasFlag } from '@/misc/utils/auth/permissionUtils.js';
import { permissionFlags } from '@/config/constants.js';
import cdnService from '@/server/services/core/CdnService.js';
import CurationSchedule from '@/models/curations/CurationSchedule.js';
import Song from '@/models/songs/Song.js';
import SongAlias from '@/models/songs/SongAlias.js';
import Artist from '@/models/artists/Artist.js';
import { formatDuration, getArtistDisplayName, getSongDisplayName } from '@/misc/utils/data/levelHelpers.js';
import { Cache } from '@/server/middleware/cache.js';
import { ApiDoc } from '@/server/middleware/apiDoc.js';
import { standardErrorResponses, standardErrorResponses404500, standardErrorResponses500, idParamSpec, errorResponseSchema } from '@/server/schemas/v2/database/levels/index.js';
import { PaginationQuery } from '@/server/interfaces/models/index.js';
import {
  pickThemeCuration,
  serializeCurationJson,
  sortCurationsByTypeOrder,
} from '@/misc/utils/data/curationOrdering.js';
import { parseFacetQueryString } from '@/misc/utils/search/facetQuery.js';

const router: Router = Router()
const elasticsearchService = ElasticsearchService.getInstance();

router.get(
  '/',
  Auth.addUserToRequest(),
  ApiDoc({
    operationId: 'getLevelsSearch',
    summary: 'Search levels',
    description:
      'Search levels with filters (query, pguRange, sort, tags, etc.). Optional facetQuery (JSON v1) replaces tagsFilter and curatedTypesFilter name lists when present. Query: page, offset, limit.',
    tags: ['Levels'],
    security: ['bearerAuth'],
    query: {
      query: { description: 'Search text', schema: { type: 'string' } },
      facetQuery: { description: 'Facet filter JSON v1 (tags + curationTypes)', schema: { type: 'string' } },
      pguRange: { description: 'PGU range', schema: { type: 'string' } },
      sort: { schema: { type: 'string' } },
      page: { schema: { type: 'integer' } },
      offset: { schema: { type: 'integer' } },
      limit: { schema: { type: 'integer' } },
    },
    responses: { 200: { description: 'Paginated level list' }, ...standardErrorResponses500 },
  }),
  async (req: Request, res: Response) => {
  try {
    const { page, limit, offset } = req.query as unknown as PaginationQuery;
    const {
      query,
      pguRange,
      specialDifficulties,
      sort,
      deletedFilter,
      clearedFilter,
      availableDlFilter,
      curatedTypesFilter,
      tagsFilter,
      facetQuery,
      onlyMyLikes,
    } = req.query;

    const startTime = Date.now();

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

    const facetQueryV1 = parseFacetQueryString(
      typeof facetQuery === 'string' ? facetQuery : undefined
    );

    // Group tags by their group field if tagsFilter is provided (ignored when facetQuery is set — handled in ES)
    let tagGroups: { [groupKey: string]: number[] } | undefined;
    if (!facetQueryV1 && tagsFilter && tagsFilter !== 'show') {
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
        tagsFilter: facetQueryV1 ? undefined : (tagsFilter as string),
        tagGroups,
        facetQueryV1,
        userId: req.user?.id,
        creatorId: req.user?.creatorId,
        offset,
        page,
        limit,
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
      page,
      offset,
      limit,
      hasMore: offset + limit < total,
      total
    });
  } catch (error) {
    logger.error('Error in level search:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get(
  '/byId/:id([0-9]{1,20})',
  Auth.addUserToRequest(),
  ApiDoc({
    operationId: 'getLevelById',
    summary: 'Get level by ID',
    description: 'Fetch a single level by numeric ID (cached)',
    tags: ['Levels'],
    security: ['bearerAuth'],
    params: { id: { description: 'Level ID', schema: { type: 'string' } } },
    responses: { 200: { description: 'Level details' }, ...standardErrorResponses404500 },
  }),
  Cache({
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
router.head(
  '/byId/:id([0-9]{1,20})',
  Auth.addUserToRequest(),
  ApiDoc({
    operationId: 'headLevelById',
    summary: 'Check level by ID',
    description: 'HEAD request to check if level exists (no body)',
    tags: ['Levels'],
    security: ['bearerAuth'],
    params: { id: idParamSpec },
    responses: { 200: { description: 'Exists' }, 404: { description: 'Not found' }, ...standardErrorResponses500 },
  }),
  async (req: Request, res: Response) => {
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

router.get(
  '/:id([0-9]{1,20})',
  Auth.addUserToRequest(),
  ApiDoc({
    operationId: 'getLevelDetails',
    summary: 'Get level by ID (slug)',
    description: 'Fetch level by ID with full details (cached)',
    tags: ['Levels'],
    security: ['bearerAuth'],
    params: { id: { description: 'Level ID', schema: { type: 'string' } } },
    responses: { 200: { description: 'Level' }, ...standardErrorResponses404500 },
  }),
  Cache({
  ttl: 60*60*24,
  varyByRole: true, // isliked checked in other endpoint
  tags: (req) => [`level:${req.params.id}`, 'levels:all']
}), async (req: Request, res: Response) => {
  try {
    if (!req.params.id || isNaN(parseInt(req.params.id)) || parseInt(req.params.id) <= 0) {
      return res.status(400).json({ error: 'Invalid level ID' });
    }
    const levelId = parseInt(req.params.id);
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
    });
    // Difficulty query (needs level's diffId)
    const difficultyPromise = levelPromise.then(async (level) => {
      if (!level) return null;
      return Difficulty.findOne({
        where: { id: level.diffId }
      });
    });

    // LevelAlias query
    const aliasesPromise = LevelAlias.findAll({
      where: { levelId: levelId },
    });
    // LevelCredit query with nested Creator and CreatorAlias
    const levelCreditsPromise = LevelCredit.findAll({
      where: { levelId: levelId },
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
      });
    });
    const curationsPromise = Curation.findAll({
      where: { levelId: levelId },
      include: [
        {
          model: CurationType,
          as: 'types',
          through: { attributes: [] },
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
    });
    // Rating query
 
    // LevelRerateHistory query
    const rerateHistoryPromise = LevelRerateHistory.findAll({
      where: { levelId: levelId },
      order: [['createdAt', 'DESC']],
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
    });
    // Execute all queries concurrently
    const [
      level,
      difficulty,
      aliases,
      levelCredits,
      teamObject,
      curationsRows,
      rerateHistory,
      tags
    ] = await Promise.all([
      levelPromise,
      difficultyPromise,
      aliasesPromise,
      levelCreditsPromise,
      teamPromise,
      curationsPromise,
      rerateHistoryPromise,
      tagsPromise
    ]);
    if (!level) {
      return res.status(404).json({ error: 'Level not found' });
    }
    // If level is deleted and user is not super admin, return 404
    if (level.isDeleted && (!req.user || !hasFlag(req.user, permissionFlags.SUPER_ADMIN))) {
      return res.status(404).json({ error: 'Level not found' });
    }
    const sortedCurations = sortCurationsByTypeOrder(curationsRows as Curation[]);
    const themeCuration = pickThemeCuration(sortedCurations as Curation[]);
    const mergedSchedules = sortedCurations.flatMap((c) => c.curationSchedules || []);

    // Assemble the level object with all related data
    const assembledLevel = {
      ...level.toJSON(),
      difficulty,
      aliases,
      levelCredits,
      teamObject,
      curations: sortedCurations.map((c) => serializeCurationJson(c)),
      curation: themeCuration ? serializeCurationJson(themeCuration) : null,
      curationSchedules: mergedSchedules.map((s) => s.toJSON()),
      tags: tags || [],
      song: getSongDisplayName(level),
      artist: getArtistDisplayName(level) || null
    };
    return res.json({
      level: assembledLevel,
      rerateHistory,
    });

  } catch (error) {
    logger.error('Error fetching level:', error);
    return res.status(500).json({ error: 'Failed to fetch level' });
  }
});

router.get(
  '/:id([0-9]{1,20})/cdnData',
  Auth.addUserToRequest(),
  ApiDoc({
    operationId: 'getLevelCdnData',
    summary: 'Get level CDN data',
    description: 'Returns CDN-related data for a level',
    tags: ['Levels'],
    security: ['bearerAuth'],
    params: { id: idParamSpec },
    responses: { 200: { description: 'CDN data' }, 400: { schema: errorResponseSchema }, ...standardErrorResponses500 },
  }),
  async (req: Request, res: Response) => {
  try {
    if (!req.params.id || isNaN(parseInt(req.params.id)) || parseInt(req.params.id) <= 0) {
      return res.status(400).json({ error: 'Invalid level ID' });
    }
    const levelId = parseInt(req.params.id);

    const level = await Level.findOne({
      where: { id: levelId },
      attributes: ['id', 'dlLink', 'isDeleted']
    });

    if (!level) {
      return res.status(404).json({ error: 'Level not found' });
    }

    if (level.isDeleted && (!req.user || !hasFlag(req.user, permissionFlags.SUPER_ADMIN))) {
      return res.status(404).json({ error: 'Level not found' });
    }

    if (!level.dlLink) {
      return res.json({ metadata: null, transformOptions: null });
    }

    try {
      // Transform options are fetched alongside the rest of the CDN data so the
      // level download popup can consume them as a prop instead of making a
      // second round-trip to the CDN when it opens. `getLevelTransformOptions`
      // swallows 404 to null and the outer catch handles other CDN failures.
      // bpm / tilecount / levelLengthInMs / downloadCount live on the Level row
      // itself and are delivered via the regular `/levels/:id` response, so
      // they intentionally aren't duplicated here.
      const [metadata, transformOptions] = await Promise.all([
        cdnService.getLevelMetadata(level).then((m) => m?.metadata ?? null),
        cdnService.getLevelTransformOptions(level).catch((err) => {
          logger.debug('Failed to fetch transform options for cdnData', {
            levelId: req.params.id,
            error: err instanceof Error ? err.message : String(err),
          });
          return null;
        }),
      ]);
      return res.json({
        metadata,
        transformOptions,
      });
    } catch (error) {
      logger.debug('Level metadata retrieval error for level:', {levelId: req.params.id, error: error instanceof Error ? error.toString() : String(error)});
      return res.json({ metadata: null, transformOptions: null });
    }
  } catch (error) {
    logger.error('Error fetching level CDN data:', error);
    return res.status(500).json({ error: 'Failed to fetch level CDN data' });
  }
});

router.get(
  '/:id([0-9]{1,20})/isLiked',
  Auth.addUserToRequest(),
  ApiDoc({
    operationId: 'getLevelIsLiked',
    summary: 'Check if level is liked',
    description: 'Returns whether the current user has liked the level',
    tags: ['Levels'],
    security: ['bearerAuth'],
    params: { id: idParamSpec },
    responses: { 200: { description: 'Liked status' }, ...standardErrorResponses500 },
  }),
  Cache({
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

router.get(
  '/:id([0-9]{1,20})/ratings',
  Auth.addUserToRequest(),
  ApiDoc({
    operationId: 'getLevelRatings',
    summary: 'Get level ratings',
    description: 'Returns ratings for a level',
    tags: ['Levels'],
    security: ['bearerAuth'],
    params: { id: idParamSpec },
    responses: { 200: { description: 'Ratings list' }, ...standardErrorResponses500 },
  }),
  async (req: Request, res: Response) => {
  try {
    const levelId = parseInt(req.params.id);
    const ratings = await Rating.findOne({
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
    });
    return res.json(ratings);
  }
  catch (error) {
    logger.error('Error fetching level ratings:', error);
    return res.status(500).json({ error: 'Failed to fetch level ratings' });
  }
});


router.get(
  '/:id([0-9]{1,20})/level.adofai',
  Auth.addUserToRequest(),
  ApiDoc({
    operationId: 'getLevelAdofai',
    summary: 'Get level .adofai file',
    description: 'Returns the level chart file content',
    tags: ['Levels'],
    security: ['bearerAuth'],
    params: { id: idParamSpec },
    responses: { 200: { description: 'File content or redirect' }, ...standardErrorResponses404500 },
  }),
  async (req: Request, res: Response) => {
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
