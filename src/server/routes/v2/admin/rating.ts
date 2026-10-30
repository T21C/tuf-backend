import Rating from '@/models/levels/Rating.js';
import Level from '@/models/levels/Level.js';
import LevelRequest from '@/models/levels/LevelRequest.js';
import { ApiDoc } from '@/server/middleware/apiDoc.js';
import {
  standardErrorResponses,
  standardErrorResponses401404500,
  standardErrorResponses500,
  stringIdParamSpec,
} from '@/server/schemas/v2/admin/index.js';
import { Auth } from '@/server/middleware/auth.js';
import sequelize from '@/config/db.js';
import Difficulty from '@/models/levels/Difficulty.js';
import User from '@/models/auth/User.js';
import { Router, Request, Response, NextFunction } from 'express';
import type { Transaction } from 'sequelize';
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
import { calculateAverageRating, isDiscordVoteCard } from '@/misc/utils/data/RatingUtils.js';
import { LevelRequestError } from '@/server/services/requests/levelRequestService.js';
import { manageRatingDiscordThread } from '@/server/services/ratings/ratingDiscordThread.js';
import { readRatingThreadRequest } from '@/misc/utils/data/ratingThread.js';
import { safeTransactionRollback } from '@/misc/utils/Utility.js';
import { hasFlag } from '@/misc/utils/auth/permissionUtils.js';
import { permissionFlags } from '@/config/constants.js';
import { CacheInvalidation } from '@/server/middleware/cache.js';
import {
  broadcastRatingUpsert,
  buildCompleteRatingById,
  buildCompleteRatingByLevelId,
  buildSlimListRowByRatingId,
  getRatingListPage,
  parseRatingListQuery,
} from '@/server/services/ratings/ratingListService.js';
import RatingDetail from '@/models/levels/RatingDetail.js';
import RatingAccuracySample from '@/models/levels/RatingAccuracySample.js';
import {
  dealZenDeck,
  parseZenDealOptions,
  sendZenMediaReport,
} from '@/server/services/ratings/zenRatingService.js';
import {
  assertNormalRatingAllowed,
  assertZenSubmitAllowed,
  deleteZenSession,
  getHydratedZenSession,
  upsertZenSession,
} from '@/server/services/ratings/zenRatingSessionService.js';
import {
  nextRatedInZen,
  ZenSessionError,
} from '@/server/services/ratings/zenRatingSessionPayload.js';
import {
  countOfficialRatingsInUtcMonth,
  enqueueTufStellarNomineeIfEligible,
} from '@/server/services/ratings/tufStellarNomineeService.js';
import {
  RatingActionError,
  blockAutoRank,
  settleExactFlow1,
  unblockAutoRank,
} from '@/server/services/ratings/ratingSettleService.js';

const router: Router = Router();

const MAX_RATING_COMMENT_LENGTH = 10_000;

async function isLockedVoteCard(ratingId: number, levelId: number, transaction: Transaction) {
  const [level, rating, request] = await Promise.all([
    Level.findByPk(levelId, {attributes: ['rerateNum'], transaction}),
    Rating.findByPk(ratingId, {attributes: ['requesterFR', 'discordMessageUrl', 'discordThreadClosed'], transaction}),
    LevelRequest.findOne({
      where: {linkedRatingId: ratingId, type: 'rerate'},
      attributes: ['immediateSettle', 'status', 'discordMessageUrl', 'discordThreadClosed'],
      transaction,
    }),
  ]);
  const requestOwnsThread = Boolean(
    request && (request.discordMessageUrl || request.immediateSettle || request.status === 'discord_vote'),
  );
  return isDiscordVoteCard({
    rerateNum: level?.rerateNum,
    requesterFR: rating?.requesterFR,
    immediateSettle: request?.immediateSettle,
    requestStatus: request?.status,
    discordMessageUrl: request?.discordMessageUrl || rating?.discordMessageUrl,
    discordThreadClosed: requestOwnsThread
      ? Boolean(request?.discordThreadClosed)
      : Boolean(rating?.discordThreadClosed),
  });
}

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
    attributes: ['id', 'role', 'sortOrder'],
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
          {
            model: RatingAccuracySample,
            as: 'accuracySample',
            required: false,
          },
        ],
      },
      { model: Difficulty, as: 'averageDifficulty', required: false },
      { model: Difficulty, as: 'communityDifficulty', required: false },
    ],
    transaction,
  };
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
      'Paged pending ratings (confirmedAt null, toRate true). Hybrid ES text search + MySQL filters. Query includeP/includeG/includeU (default all on) hides cards by the AutoRater average band, same as Zen Mode. Cards with no AutoRater vote stay listed. fourVote hide/only compares the non-community rating count with fourVoteMin (default 4). Cached public pages; myRated hide/only uncached.',
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
      'Returns a finite snapshot deck for Zen Mode (unrated by user, <4 manager votes, exclude VOTE). Query: deckSize (1–200), includeP, includeG, includeU, sort, order, randomness (0–100; 0 = strict sort order, 100 = uniform across pool). peeksAllowed is floor(dealtCards / 5). Uncached.',
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
  '/zen/session',
  Auth.user(),
  ApiDoc({
    operationId: 'getAdminRatingZenSession',
    summary: 'Load saved Zen Mode session',
    description:
      'Returns the current user compact Zen deck plus hydrated rating cards. Missing or settled ids are dropped.',
    tags: ['Admin', 'Rating'],
    responses: { 200: { description: 'Zen session or null' }, ...standardErrorResponses },
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
      const session = await getHydratedZenSession(user.id);
      return res.json({ session });
    } catch (error) {
      logger.error('Error loading Zen session:', error);
      return res.status(500).json({ error: 'Failed to load Zen session' });
    }
  }
);

router.put(
  '/zen/session',
  Auth.user(),
  ApiDoc({
    operationId: 'putAdminRatingZenSession',
    summary: 'Save Zen Mode session',
    description:
      'Upsert compact Zen deck progress for the current user (rating ids, not full snapshots).',
    tags: ['Admin', 'Rating'],
    security: ['bearerAuth'],
    requestBody: {
      required: true,
      schema: { type: 'object', additionalProperties: true },
    },
    responses: { 200: { description: 'Saved Zen session' }, ...standardErrorResponses },
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
      const payload = await upsertZenSession(user.id, req.body);
      return res.json({ session: payload });
    } catch (error) {
      if (error instanceof ZenSessionError) {
        return res.status(error.status).json({ error: error.message });
      }
      logger.error('Error saving Zen session:', error);
      return res.status(500).json({ error: 'Failed to save Zen session' });
    }
  }
);

router.delete(
  '/zen/session',
  Auth.user(),
  ApiDoc({
    operationId: 'deleteAdminRatingZenSession',
    summary: 'Discard Zen Mode session',
    description: 'Delete the current user saved Zen deck and progress.',
    tags: ['Admin', 'Rating'],
    security: ['bearerAuth'],
    responses: { 200: { description: 'Zen session discarded' }, ...standardErrorResponses },
  }),
  async (req: Request, res: Response) => {
    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json({ error: 'User not found' });
      }
      await deleteZenSession(user.id);
      return res.json({ ok: true });
    } catch (error) {
      logger.error('Error deleting Zen session:', error);
      return res.status(500).json({ error: 'Failed to discard Zen session' });
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

router.post(
  '/:id([0-9]+)/discord',
  Auth.verified(),
  ApiDoc({
    operationId: 'postRatingDiscordThread',
    summary: 'Create, close, or reopen a Discord vote thread for a manually added rating',
    description: 'Same vote-thread process as a rerate request, for a rating that has no website request. Body: {action: create|close|reopen, ping?: boolean}. Pings default off. Closing returns the chart to website rating.',
    tags: ['Admin', 'Rating'],
    security: ['bearerAuth'],
    params: { id: stringIdParamSpec },
    responses: { 200: { description: 'Discord thread created' }, ...standardErrorResponses },
  }),
  async (req: Request, res: Response) => {
    try {
      const {action, ping} = readRatingThreadRequest(req.body);
      const rating = await manageRatingDiscordThread(req.user, Number(req.params.id), action, ping);
      return res.json({ rating });
    } catch (error) {
      if (error instanceof LevelRequestError) {
        return res.status(error.status).json({ error: error.message, code: error.code });
      }
      logger.error('Error updating a rating Discord thread:', error);
      return res.status(500).json({ error: 'Failed to update the Discord thread' });
    }
  },
);

// Update rating
router.put(
  '/:id',
  Auth.verified(),
  ApiDoc({
    operationId: 'putAdminRating',
    summary: 'Update rating',
    description:
      'Submit or update rating detail. Body: rating, comment?, isCommunityRating?, ratedInZen?, viewDurationSeconds?. Verified; rater for non-community.',
    tags: ['Admin', 'Rating'],
    security: ['bearerAuth'],
    params: { id: stringIdParamSpec },
    requestBody: {
      description: 'rating, comment, isCommunityRating, ratedInZen, viewDurationSeconds',
      schema: {
        type: 'object',
        properties: {
          rating: { type: 'string' },
          comment: { type: 'string' },
          isCommunityRating: { type: 'boolean' },
          ratedInZen: { type: 'boolean' },
          viewDurationSeconds: { type: 'integer', minimum: 0 },
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
        ratedInZen: ratedInZenBody,
        viewDurationSeconds: viewDurationSecondsBody,
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

      const lockedRating = await Rating.findByPk(Number(id), {
        attributes: ['id', 'levelId', 'confirmedAt', 'createdAt'],
        transaction,
      });
      if (!lockedRating) {
        await safeTransactionRollback(transaction);
        return res.status(404).json({ error: 'Rating not found' });
      }
      if (lockedRating.confirmedAt != null) {
        await safeTransactionRollback(transaction);
        return res.status(409).json({ error: 'Cannot change ratings after a level has been settled' });
      }
      if (await isLockedVoteCard(lockedRating.id, lockedRating.levelId, transaction)) {
        await safeTransactionRollback(transaction);
        return res.status(403).json({
          error: 'Vote cards are settled from Discord and cannot be rated on the site',
        });
      }

      if (!isCommunityRating && !hasFlag(user, permissionFlags.RATER)) {
        await safeTransactionRollback(transaction);
        return res.status(403).json({ error: 'User is not a rater' });
      }

      if (!rating || rating.trim() === '') {
        try {
          await assertNormalRatingAllowed(user.id);
        } catch (error) {
          await safeTransactionRollback(transaction);
          if (error instanceof ZenSessionError) {
            return res.status(error.status).json({ error: error.message });
          }
          throw error;
        }
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

      const bodyRatedInZen =
        ratedInZenBody === true || ratedInZenBody === 'true' || ratedInZenBody === '1';
      const existingDetail = await RatingDetail.findOne({
        where: { ratingId: Number(id), userId: user.id },
        transaction,
      });
      const ratedInZenDecision = nextRatedInZen(bodyRatedInZen, Boolean(existingDetail));
      if (!ratedInZenDecision.ok) {
        await safeTransactionRollback(transaction);
        return res.status(ratedInZenDecision.status).json({ error: ratedInZenDecision.error });
      }
      try {
        if (bodyRatedInZen) {
          await assertZenSubmitAllowed(user.id, Number(id));
        } else {
          await assertNormalRatingAllowed(user.id);
        }
      } catch (error) {
        await safeTransactionRollback(transaction);
        if (error instanceof ZenSessionError) {
          return res.status(error.status).json({ error: error.message });
        }
        throw error;
      }
      const isNewOfficialRaterVote =
        !existingDetail &&
        !isCommunityRating &&
        hasFlag(user, permissionFlags.RATER);
      const nomineeNow = new Date();
      const priorOfficialCountThisMonth = isNewOfficialRaterVote
        ? await countOfficialRatingsInUtcMonth(user.id, nomineeNow, transaction)
        : 0;
      const ratedInZen = ratedInZenDecision.ratedInZen;

      const parentRating = lockedRating;

      const parsedViewDuration = Number(viewDurationSecondsBody);
      const clientViewSeconds =
        Number.isFinite(parsedViewDuration) && parsedViewDuration > 0
          ? Math.floor(parsedViewDuration)
          : 0;
      const ratingCreatedAt = (parentRating as Rating & { createdAt?: Date }).createdAt;
      const maxAgeSec = Math.max(
        0,
        Math.floor((Date.now() - new Date(ratingCreatedAt ?? Date.now()).getTime()) / 1000)
      );
      const clampedClient = Math.min(Math.max(0, clientViewSeconds), maxAgeSec);
      const existingViewSeconds = Math.max(0, existingDetail?.viewDurationSeconds ?? 0);
      const viewDurationSeconds = Math.min(maxAgeSec, Math.max(existingViewSeconds, clampedClient));

      await RatingDetail.upsert(
        {
          ratingId: Number(id),
          userId: user.id,
          rating: rating || '',
          comment: comment || '',
          isCommunityRating,
          ratedInZen,
          viewDurationSeconds,
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

      if (isNewOfficialRaterVote) {
        try {
          await enqueueTufStellarNomineeIfEligible({
            user,
            isNewOfficialRaterVote: true,
            priorOfficialCountThisMonth,
            now: nomineeNow,
          });
        } catch (err) {
          logger.error('[tufstellar-nominee] Failed to enqueue nominee webhook', {
            userId: user.id,
            error: err,
          });
        }
      }

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

      const lockedRating = await Rating.findByPk(Number(id), {
        attributes: ['id', 'levelId', 'confirmedAt'],
        transaction,
      });
      if (!lockedRating) {
        await safeTransactionRollback(transaction);
        return res.status(404).json({ error: 'Rating not found' });
      }
      if (lockedRating.confirmedAt != null) {
        await safeTransactionRollback(transaction);
        return res.status(409).json({ error: 'Cannot change ratings after a level has been settled' });
      }
      if (await isLockedVoteCard(lockedRating.id, lockedRating.levelId, transaction)) {
        await safeTransactionRollback(transaction);
        return res.status(403).json({
          error: 'Vote cards are settled from Discord and cannot be rated on the site',
        });
      }

      try {
        await assertNormalRatingAllowed(currentUser.id);
      } catch (error) {
        await safeTransactionRollback(transaction);
        if (error instanceof ZenSessionError) {
          return res.status(error.status).json({ error: error.message });
        }
        throw error;
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

router.post(
  '/:id/settle',
  Auth.verified(),
  ApiDoc({
    operationId: 'postAdminRatingSettle',
    summary: 'Settle an exact Flow 1 match',
    description: 'Applies the agreed difficulty when the server says a rater may settle. The one-step-off case is rejected.',
    tags: ['Admin', 'Rating'],
    security: ['bearerAuth'],
    params: { id: stringIdParamSpec },
    responses: { 200: { description: 'Rating settled' }, ...standardErrorResponses },
  }),
  async (req: Request, res: Response) => {
    try {
      if (!req.user) return res.status(401).json({ error: 'User not found' });
      const complete = await settleExactFlow1(Number(req.params.id), req.user!);
      return res.json({ message: 'Rating settled', complete });
    } catch (error) {
      return sendRatingActionError(res, error, 'Failed to settle rating');
    }
  },
);

router.post(
  '/:id/block',
  Auth.verified(),
  ApiDoc({
    operationId: 'postAdminRatingBlock',
    summary: 'Block auto rank on an open rating',
    description: 'Any rater can block auto rank for this open rating. Optional reason.',
    tags: ['Admin', 'Rating'],
    security: ['bearerAuth'],
    params: { id: stringIdParamSpec },
    responses: { 200: { description: 'Auto rank blocked' }, ...standardErrorResponses },
  }),
  async (req: Request, res: Response) => {
    try {
      if (!req.user) return res.status(401).json({ error: 'User not found' });
      const complete = await blockAutoRank(Number(req.params.id), req.user!, req.body?.reason);
      return res.json({ message: 'Auto rank blocked', complete });
    } catch (error) {
      return sendRatingActionError(res, error, 'Failed to block auto rank');
    }
  },
);

router.post(
  '/:id/unblock',
  Auth.verified(),
  ApiDoc({
    operationId: 'postAdminRatingUnblock',
    summary: 'Clear an auto rank block',
    description: 'Super admins can remove a rater block from an open rating.',
    tags: ['Admin', 'Rating'],
    security: ['bearerAuth'],
    params: { id: stringIdParamSpec },
    responses: { 200: { description: 'Auto rank unblocked' }, ...standardErrorResponses },
  }),
  async (req: Request, res: Response) => {
    try {
      if (!req.user) return res.status(401).json({ error: 'User not found' });
      const complete = await unblockAutoRank(Number(req.params.id), req.user!);
      return res.json({ message: 'Auto rank unblocked', complete });
    } catch (error) {
      return sendRatingActionError(res, error, 'Failed to unblock auto rank');
    }
  },
);

function sendRatingActionError(res: Response, error: unknown, fallback: string) {
  if (error instanceof RatingActionError) {
    return res.status(error.statusCode).json({ error: error.message });
  }
  logger.error(fallback, error);
  return res.status(500).json({ error: fallback });
}

export default router;
