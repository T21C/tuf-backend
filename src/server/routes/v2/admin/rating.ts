import { Auth } from '@/server/middleware/auth.js';
import { ApiDoc } from '@/server/middleware/apiDoc.js';
import {
  standardErrorResponses,
  standardErrorResponses401404500,
  standardErrorResponses500,
  stringIdParamSpec,
} from '@/server/schemas/v2/admin/index.js';
import Rating from '@/models/levels/Rating.js';
import RatingDetail from '@/models/levels/RatingDetail.js';
import Level from '@/models/levels/Level.js';
import { sseManager } from '@/misc/utils/server/sse.js';
import sequelize from '@/config/db.js';
import Difficulty from '@/models/levels/Difficulty.js';
import User from '@/models/auth/User.js';
import { Router, Request, Response, NextFunction } from 'express';
import Team from '@/models/credits/Team.js';
import { TeamAlias } from '@/models/credits/TeamAlias.js';
import Creator from '@/models/credits/Creator.js';
import { CreatorAlias } from '@/models/credits/CreatorAlias.js';
import LevelCredit from '@/models/levels/LevelCredit.js';
import LevelAlias from '@/models/levels/LevelAlias.js';
import Song from '@/models/songs/Song.js';
import SongAlias from '@/models/songs/SongAlias.js';
import SongCredit from '@/models/songs/SongCredit.js';
import Artist from '@/models/artists/Artist.js';
import ArtistAlias from '@/models/artists/ArtistAlias.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { calculateAverageRating } from '@/misc/utils/data/RatingUtils.js';
import { safeTransactionRollback } from '@/misc/utils/Utility.js';
import { hasFlag } from '@/misc/utils/auth/permissionUtils.js';
import { permissionFlags } from '@/config/constants.js';
import { CacheInvalidation } from '@/server/middleware/cache.js';
import {
  buildCompleteRatingById,
  buildCompleteRatingByLevelId,
  buildSlimListRowByRatingId,
  getRatingListPage,
  parseRatingListQuery,
} from '@/server/services/ratings/ratingListService.js';
import {
  dealZenDeck,
  parseZenDealOptions,
  sendZenMediaReport,
} from '@/server/services/ratings/zenRatingService.js';

const router: Router = Router();

const MAX_RATING_COMMENT_LENGTH = 10_000;

/** Level includes for mutation / complete responses (aliases for song, artist, creators, team). */
const ratingLevelSearchIncludes = [
  {
    model: LevelAlias,
    as: 'aliases',
    attributes: ['field', 'alias'],
    required: false,
  },
  {
    model: Song,
    as: 'songObject',
    attributes: ['id', 'name'],
    required: false,
    include: [
      {
        model: SongAlias,
        as: 'aliases',
        attributes: ['alias'],
        required: false,
      },
      {
        model: SongCredit,
        as: 'credits',
        attributes: ['role'],
        required: false,
        include: [
          {
            model: Artist,
            as: 'artist',
            attributes: ['id', 'name'],
            required: false,
            include: [
              {
                model: ArtistAlias,
                as: 'aliases',
                attributes: ['alias'],
                required: false,
              },
            ],
          },
        ],
      },
    ],
  },
  {
    model: Team,
    as: 'teamObject',
    attributes: ['name'],
    required: false,
    include: [
      {
        model: TeamAlias,
        as: 'teamAliases',
        attributes: ['name'],
        required: false,
      },
    ],
  },
  {
    model: LevelCredit,
    as: 'levelCredits',
    required: false,
    attributes: ['id', 'role'],
    include: [
      {
        model: Creator,
        as: 'creator',
        attributes: ['name', 'id'],
        include: [
          {
            model: CreatorAlias,
            as: 'creatorAliases',
            attributes: ['name'],
            required: false,
          },
        ],
      },
    ],
  },
];

/** Reusable options for fetching a rating with full includes after mutations. */
function fullRatingIncludeOptions(transaction: any) {
  return {
    include: [
      {
        model: Level,
        as: 'level',
        where: { isDeleted: false, isHidden: false },
        required: false,
        include: [
          { model: Difficulty, as: 'difficulty', required: false },
          ...ratingLevelSearchIncludes,
        ],
      },
      {
        model: RatingDetail,
        as: 'details',
        include: [
          {
            model: User,
            as: 'user',
            attributes: ['id', 'username', 'nickname', 'avatarUrl'],
          },
        ],
      },
      { model: Difficulty, as: 'averageDifficulty', required: false },
      { model: Difficulty, as: 'communityDifficulty', required: false },
    ],
    transaction,
  };
}

async function broadcastRatingUpsert(ratingId: number, levelId: number) {
  const listRow = await buildSlimListRowByRatingId(ratingId);
  const complete = await buildCompleteRatingById(ratingId);
  sseManager.broadcast({
    type: 'ratingUpdate',
    data: {
      ratingId,
      levelId,
      action: listRow ? 'upsert' : 'remove',
      listRow,
      complete,
    },
  });
}

// Public read: the rating page renders for anonymous visitors, and signed-in
// non-raters rate from it as community raters (see PUT /:id below).
router.get(
  '/',
  Auth.addUserToRequest(),
  ApiDoc({
    operationId: 'getAdminRatings',
    summary: 'Unconfirmed ratings (paged)',
    description:
      'Paged pending ratings (confirmedAt null, toRate true). Hybrid ES text search + MySQL filters. Cached public pages; hideRated uncached.',
    tags: ['Admin', 'Rating'],
    responses: { 200: { description: 'Paged ratings list' }, ...standardErrorResponses500 },
  }),
  async (req: Request, res: Response) => {
    try {
      const params = parseRatingListQuery(
        req.query as Record<string, unknown>,
        req.user?.id ?? null
      );
      const page = await getRatingListPage(params);
      return res.json(page);
    } catch (error) {
      logger.error('Error fetching ratings:', error);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  }
);

router.get(
  '/zen/deal',
  Auth.addUserToRequest(),
  ApiDoc({
    operationId: 'getAdminRatingZenDeal',
    summary: 'Deal a Zen Mode rating deck',
    description:
      'Returns a finite snapshot deck for Zen Mode (unrated by user, <4 manager votes, exclude VOTE). Query: deckSize, onlyLowDiff, sort, order. Uncached.',
    tags: ['Admin', 'Rating'],
    responses: { 200: { description: 'Zen deck' }, ...standardErrorResponses },
  }),
  async (req: Request, res: Response) => {
    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json({ error: 'User not found' });
      }
      if (hasFlag(user, permissionFlags.RATING_BANNED)) {
        return res.status(403).json({ error: 'User is banned from rating' });
      }

      const query = (req.query || {}) as Record<string, unknown>;
      try {
        parseZenDealOptions(query);
      } catch (e: any) {
        return res.status(e?.status || 400).json({ error: e?.message || 'Invalid deal options' });
      }

      const deck = await dealZenDeck(user.id, query);
      return res.json(deck);
    } catch (error) {
      logger.error('Error dealing Zen deck:', error);
      return res.status(500).json({ error: 'Failed to deal Zen deck' });
    }
  }
);

router.post(
  '/zen/report',
  Auth.verified(),
  ApiDoc({
    operationId: 'postAdminRatingZenReport',
    summary: 'Report bad media from Zen Mode',
    description: 'Sends a Discord webhook report for a Zen Mode card (ratingId, levelId, optional note).',
    tags: ['Admin', 'Rating'],
    security: ['bearerAuth'],
    requestBody: {
      description: 'ratingId, levelId, note',
      schema: {
        type: 'object',
        properties: {
          ratingId: { type: 'integer' },
          levelId: { type: 'integer' },
          note: { type: 'string' },
        },
        required: ['ratingId', 'levelId'],
      },
      required: true,
    },
    responses: { 200: { description: 'Report delivered' }, ...standardErrorResponses },
  }),
  async (req: Request, res: Response) => {
    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json({ error: 'User not found' });
      }
      if (hasFlag(user, permissionFlags.RATING_BANNED)) {
        return res.status(403).json({ error: 'User is banned from rating' });
      }

      const ratingId = Number(req.body?.ratingId);
      const levelId = Number(req.body?.levelId);
      if (!Number.isFinite(ratingId) || ratingId <= 0 || !Number.isFinite(levelId) || levelId <= 0) {
        return res.status(400).json({ error: 'ratingId and levelId are required' });
      }

      await sendZenMediaReport({
        reporterId: user.id,
        reporterName: user.nickname || user.username || user.id,
        reporterAvatarUrl: user.avatarUrl,
        reporterPlayerId: user.playerId ?? null,
        ratingId,
        levelId,
        note: typeof req.body?.note === 'string' ? req.body.note : undefined,
      });

      return res.json({ ok: true, delivered: true });
    } catch (error: any) {
      const status = error?.status || 500;
      if (status === 503) {
        return res.status(503).json({ error: 'Report webhook is not configured', delivered: false });
      }
      logger.error('Error sending Zen media report:', error);
      return res.status(500).json({ error: 'Failed to send report' });
    }
  }
);

router.get(
  '/by-level/:levelId',
  Auth.addUserToRequest(),
  ApiDoc({
    operationId: 'getAdminRatingByLevelId',
    summary: 'Pending rating by level id',
    description: 'Fetch pending rating for a level. Pass completeObject=true for popup/deep-link payload.',
    tags: ['Admin', 'Rating'],
    params: { levelId: stringIdParamSpec },
    responses: { 200: { description: 'Rating' }, ...standardErrorResponses401404500 },
  }),
  async (req: Request, res: Response) => {
    try {
      const levelId = parseInt(String(req.params.levelId), 10);
      if (!Number.isFinite(levelId) || levelId <= 0) {
        return res.status(400).json({ error: 'Invalid level id' });
      }
      const rating = await buildCompleteRatingByLevelId(levelId);
      if (!rating) {
        return res.status(404).json({ error: 'Rating not found' });
      }
      return res.json(rating);
    } catch (error) {
      logger.error('Error fetching rating by level:', error);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  }
);

router.get(
  '/:id',
  Auth.addUserToRequest(),
  ApiDoc({
    operationId: 'getAdminRatingById',
    summary: 'Rating by id',
    description: 'Fetch a single rating. Pass completeObject=true for popup/deep-link payload with comments and users.',
    tags: ['Admin', 'Rating'],
    params: { id: stringIdParamSpec },
    responses: { 200: { description: 'Rating' }, ...standardErrorResponses401404500 },
  }),
  async (req: Request, res: Response) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid rating id' });
      }
      const rating = await buildCompleteRatingById(id);
      if (!rating) {
        return res.status(404).json({ error: 'Rating not found' });
      }
      return res.json(rating);
    } catch (error) {
      logger.error('Error fetching rating by id:', error);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  }
);

// Update rating
router.put(
  '/:id',
  Auth.verified(),
  ApiDoc({
    operationId: 'putAdminRating',
    summary: 'Update rating',
    description:
      'Submit or update rating detail. Body: rating, comment?, isCommunityRating?. Verified; rater for non-community.',
    tags: ['Admin', 'Rating'],
    security: ['bearerAuth'],
    params: { id: stringIdParamSpec },
    requestBody: {
      description: 'rating, comment, isCommunityRating',
      schema: {
        type: 'object',
        properties: {
          rating: { type: 'string' },
          comment: { type: 'string' },
          isCommunityRating: { type: 'boolean' },
        },
      },
      required: true,
    },
    responses: { 200: { description: 'Rating updated' }, ...standardErrorResponses },
  }),
  async (req: Request, res: Response) => {
    let transaction: any;

    try {
      const { id } = req.params;
      const {
        rating: ratingString,
        comment: commentString,
        isCommunityRating = false,
      } = req.body;

      if (typeof commentString === 'string' && commentString.length > MAX_RATING_COMMENT_LENGTH) {
        return res
          .status(400)
          .json({ error: `Comment must not exceed ${MAX_RATING_COMMENT_LENGTH} characters` });
      }

      transaction = await sequelize.transaction();
      const user = req.user;
      const rating = typeof ratingString === 'string' ? ratingString.slice(0, 254) : '';
      const comment = typeof commentString === 'string' ? commentString : '';
      if (!user) {
        await safeTransactionRollback(transaction);
        return res.status(401).json({ error: 'User not found' });
      }

      if (hasFlag(user, permissionFlags.RATING_BANNED)) {
        await safeTransactionRollback(transaction);
        return res.status(403).json({ error: 'User is banned from rating' });
      }

      if (!isCommunityRating && !hasFlag(user, permissionFlags.RATER)) {
        await safeTransactionRollback(transaction);
        return res.status(403).json({ error: 'User is not a rater' });
      }

      if (!rating || rating.trim() === '') {
        await RatingDetail.destroy({
          where: {
            ratingId: id,
            userId: user.id,
          },
          transaction,
        });

        const details = await RatingDetail.findAll({
          where: { ratingId: id },
          transaction,
        });

        const averageDifficulty = await calculateAverageRating(details, transaction);
        const communityDifficulty = await calculateAverageRating(details, transaction, true);

        await Rating.update(
          {
            averageDifficultyId: averageDifficulty?.id ?? null,
            communityDifficultyId: communityDifficulty?.id ?? null,
          },
          { where: { id }, transaction }
        );

        const updatedRating = await Rating.findByPk(id, fullRatingIncludeOptions(transaction));

        await transaction.commit();
        await CacheInvalidation.invalidateTag('admin:ratings');

        const levelId = updatedRating?.levelId ?? (updatedRating as any)?.level?.id;
        if (levelId) {
          await broadcastRatingUpsert(Number(id), Number(levelId));
        }

        return res.json({
          message: 'Rating detail deleted successfully',
          rating: updatedRating,
          listRow: levelId ? await buildSlimListRowByRatingId(Number(id)) : null,
          complete: await buildCompleteRatingById(Number(id)),
        });
      }

      await RatingDetail.upsert(
        {
          ratingId: Number(id),
          userId: user.id,
          rating: rating || '',
          comment: comment || '',
          isCommunityRating,
        },
        { transaction }
      );

      const details = await RatingDetail.findAll({
        where: { ratingId: id },
        transaction,
      });

      const averageDifficulty = await calculateAverageRating(details, transaction);
      const communityDifficulty = await calculateAverageRating(details, transaction, true);

      const [updatedCount] = await Rating.update(
        {
          averageDifficultyId: averageDifficulty?.id ?? null,
          communityDifficultyId: communityDifficulty?.id ?? null,
        },
        { where: { id }, transaction }
      );
      if (updatedCount === 0) {
        await safeTransactionRollback(transaction);
        return res.status(404).json({ error: 'Rating not found' });
      }

      const updatedRating = await Rating.findByPk(id, fullRatingIncludeOptions(transaction));

      await transaction.commit();

      await CacheInvalidation.invalidateTag('admin:ratings').catch((err) =>
        logger.error('Error invalidating admin ratings cache:', err)
      );

      const levelId = updatedRating?.levelId ?? (updatedRating as any)?.level?.id;
      if (levelId) {
        await broadcastRatingUpsert(Number(id), Number(levelId));
      }

      return res.json({
        message: 'Rating updated successfully',
        rating: updatedRating,
        listRow: levelId ? await buildSlimListRowByRatingId(Number(id)) : null,
        complete: await buildCompleteRatingById(Number(id)),
      });
    } catch (error) {
      await safeTransactionRollback(transaction);
      logger.error('Error updating rating:', error);
      return res.status(500).json({ error: 'Failed to update rating' });
    }
  }
);

// Delete rating detail
router.delete(
  '/:id/detail/:userId',
  ApiDoc({
    operationId: 'deleteAdminRatingDetail',
    summary: 'Delete rating detail',
    description: "Remove a user's rating detail. Rater (own) or super admin.",
    tags: ['Admin', 'Rating'],
    security: ['bearerAuth'],
    params: { id: stringIdParamSpec, userId: stringIdParamSpec },
    responses: { 200: { description: 'Detail deleted' }, ...standardErrorResponses401404500 },
  }),
  [
    Auth.rater(),
    async (req: Request, res: Response, next: NextFunction) => {
      if (req.user?.id === req.params.userId) {
        return next();
      }
      return Auth.superAdmin()(req, res, next);
    },
  ],
  async (req: Request, res: Response) => {
    let transaction: any;

    try {
      transaction = await sequelize.transaction();
      const { id, userId } = req.params;
      const currentUser = req.user;
      if (!currentUser) {
        await safeTransactionRollback(transaction);
        return res.status(401).json({ error: 'User not authenticated' });
      }

      await RatingDetail.destroy({
        where: {
          ratingId: id,
          userId: userId,
        },
        transaction,
      });

      const details = await RatingDetail.findAll({
        where: { ratingId: id },
        transaction,
      });

      const averageDifficulty = await calculateAverageRating(details, transaction);
      const communityDifficulty = await calculateAverageRating(details, transaction, true);

      await Rating.update(
        {
          averageDifficultyId: averageDifficulty?.id ?? null,
          communityDifficultyId: communityDifficulty?.id ?? null,
        },
        { where: { id }, transaction }
      );

      const updatedRating = await Rating.findByPk(id, fullRatingIncludeOptions(transaction));

      await transaction.commit();
      await CacheInvalidation.invalidateTag('admin:ratings').catch((err) =>
        logger.error('Error invalidating admin ratings cache:', err)
      );

      const levelId = updatedRating?.levelId ?? (updatedRating as any)?.level?.id;
      if (levelId) {
        await broadcastRatingUpsert(Number(id), Number(levelId));
      }

      return res.json({
        message: 'Rating detail confirmed successfully',
        rating: updatedRating,
        listRow: levelId ? await buildSlimListRowByRatingId(Number(id)) : null,
        complete: await buildCompleteRatingById(Number(id)),
      });
    } catch (error: unknown) {
      await safeTransactionRollback(transaction);
      logger.error('Error confirming rating detail:', error);
      return res.status(500).json({ error: 'Failed to confirm rating detail' });
    }
  }
);

export default router;
