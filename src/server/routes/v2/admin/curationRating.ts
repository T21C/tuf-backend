import {Router, Request, Response} from 'express';
import sequelize from '@/config/db.js';
import {Auth} from '@/server/middleware/auth.js';
import {ApiDoc} from '@/server/middleware/apiDoc.js';
import {
  standardErrorResponses,
  standardErrorResponses401404500,
  standardErrorResponses500,
  stringIdParamSpec,
} from '@/server/schemas/v2/admin/index.js';
import {logger} from '@/server/services/core/LoggerService.js';
import {safeTransactionRollback, sanitizeTextInput} from '@/misc/utils/Utility.js';
import {hasAnyFlag, hasFlag} from '@/misc/utils/auth/permissionUtils.js';
import {permissionFlags} from '@/config/constants.js';
import CurationRating from '@/models/curations/CurationRating.js';
import CurationRatingDetail from '@/models/curations/CurationRatingDetail.js';
import Level from '@/models/levels/Level.js';
import ElasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';
import {
  assertCurationRatingPicks,
  collectedTypeIds,
  CurationRatingPickError,
  parseCurationRatingPicks,
  picksAreEmpty,
} from '@/misc/utils/data/curationRatingPicks.js';
import {
  curationAnnouncementKind,
  isCurationDiscordVoteCard,
  parseCurationFlow,
} from '@/misc/utils/data/curationFlow.js';
import {
  buildCompleteCurationRatingById,
  buildCompleteCurationRatingByLevelId,
  getCurationRatingListPage,
  parseCurationRatingListQuery,
} from '@/server/services/curations/curationRatingListService.js';
import {
  closeCurationQueue,
  replaceLevelCurationTypes,
} from '@/server/services/curations/curationRatingSettleService.js';
import {confirmOpenCurationRating} from '@/server/services/curations/openCurationRatingService.js';
import {enqueueCurationAnnouncement} from '@/server/services/announcements/curationAnnouncementQueue.js';
import {completeLevelRequestForSettledCuration, LevelRequestError} from '@/server/services/requests/levelRequestService.js';
import {manageCurationDiscordThread} from '@/server/services/curations/curationDiscordThread.js';
import {readRatingThreadRequest} from '@/misc/utils/data/ratingThread.js';
import {dealZenCurationDeck, sendCurationZenMediaReport} from '@/server/services/curations/zenCurationService.js';
import {
  assertNormalCurationRatingAllowed,
  assertZenCurationSubmitAllowed,
  deleteZenCurationSession,
  getHydratedZenCurationSession,
  upsertZenCurationSession,
} from '@/server/services/curations/zenCurationSessionService.js';
import {parseZenDeckSize, ZEN_DEFAULT_DECK_SIZE} from '@/server/services/ratings/zenRatingConstants.js';
import {ZenSessionError} from '@/server/services/ratings/zenRatingSessionPayload.js';

const router: Router = Router();
const elasticsearchService = ElasticsearchService.getInstance();
const MAX_COMMENT_LENGTH = 10_000;

const SETTLE_FLAGS = [
  permissionFlags.CURATOR,
  permissionFlags.HEAD_CURATOR,
  permissionFlags.SUPER_ADMIN,
];
const SAVE_FLAGS = [
  permissionFlags.RATER,
  permissionFlags.CURATOR,
  permissionFlags.HEAD_CURATOR,
  permissionFlags.SUPER_ADMIN,
];

function canSaveCurationRating(user: Express.Request['user']): boolean {
  return Boolean(user && hasAnyFlag(user, SAVE_FLAGS));
}

function canSettleCurationRating(user: Express.Request['user']): boolean {
  return Boolean(user && hasAnyFlag(user, SETTLE_FLAGS));
}

function readRatedInZen(body: Record<string, unknown>): boolean {
  return body.ratedInZen === true || body.ratedInZen === 'true' || body.ratedInZen === '1';
}

async function isLockedCurationVote(
  rating: CurationRating,
  transaction?: import('sequelize').Transaction,
): Promise<boolean> {
  const level = await Level.findByPk(rating.levelId, {
    attributes: ['curationRerateNum'],
    transaction,
  });
  return isCurationDiscordVoteCard({
    curationRerateNum: level?.curationRerateNum,
    discordMessageUrl: rating.discordMessageUrl,
    discordThreadClosed: rating.discordThreadClosed,
  });
}

router.get(
  '/',
  Auth.addUserToRequest(),
  ApiDoc({
    operationId: 'getAdminCurationRatings',
    summary: 'Open curation rating queue (paged)',
    description:
      'Paged pending curation ratings (confirmedAt null, toCuration true). Query: offset, limit, sort, order, myRated, query.',
    tags: ['Admin', 'Curation Rating'],
    responses: {200: {description: 'Paged curation ratings'}, ...standardErrorResponses500},
  }),
  async (req: Request, res: Response) => {
    try {
      const params = parseCurationRatingListQuery(
        req.query as Record<string, unknown>,
        req.user?.id ?? null,
      );
      const page = await getCurationRatingListPage(params);
      return res.json(page);
    } catch (error) {
      logger.error('Error fetching curation ratings:', error);
      return res.status(500).json({error: 'Internal Server Error'});
    }
  },
);

router.get(
  '/zen/deal',
  Auth.addUserToRequest(),
  ApiDoc({
    operationId: 'getAdminCurationRatingZenDeal',
    summary: 'Deal a Zen Mode curation deck',
    description:
      'Finite snapshot deck for curation Zen Mode (unrated by user, exclude Discord vote). Query: deckSize, sort, order, randomness.',
    tags: ['Admin', 'Curation Rating'],
    responses: {200: {description: 'Zen deck'}, ...standardErrorResponses},
  }),
  async (req: Request, res: Response) => {
    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json({error: 'User not found'});
      }
      if (hasFlag(user, permissionFlags.RATING_BANNED)) {
        return res.status(403).json({error: 'User is banned from rating'});
      }
      const query = (req.query || {}) as Record<string, unknown>;
      try {
        parseZenDeckSize(query.deckSize ?? ZEN_DEFAULT_DECK_SIZE);
      } catch (error: any) {
        return res.status(error?.status || 400).json({error: error?.message || 'Invalid deal options'});
      }
      const deck = await dealZenCurationDeck(user.id, query);
      return res.json(deck);
    } catch (error) {
      logger.error('Error dealing curation Zen deck:', error);
      return res.status(500).json({error: 'Failed to deal Zen deck'});
    }
  },
);

router.post(
  '/zen/report',
  Auth.verified(),
  ApiDoc({
    operationId: 'postAdminCurationRatingZenReport',
    summary: 'Report bad media from curation Zen Mode',
    tags: ['Admin', 'Curation Rating'],
    security: ['bearerAuth'],
    requestBody: {
      description: 'ratingId, levelId, note',
      schema: {
        type: 'object',
        properties: {
          ratingId: {type: 'integer'},
          levelId: {type: 'integer'},
          note: {type: 'string'},
        },
        required: ['ratingId', 'levelId'],
      },
      required: true,
    },
    responses: {200: {description: 'Report delivered'}, ...standardErrorResponses},
  }),
  async (req: Request, res: Response) => {
    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json({error: 'User not found'});
      }
      if (hasFlag(user, permissionFlags.RATING_BANNED)) {
        return res.status(403).json({error: 'User is banned from rating'});
      }
      const ratingId = Number(req.body?.ratingId);
      const levelId = Number(req.body?.levelId);
      if (!Number.isFinite(ratingId) || ratingId <= 0 || !Number.isFinite(levelId) || levelId <= 0) {
        return res.status(400).json({error: 'ratingId and levelId are required'});
      }
      await sendCurationZenMediaReport({
        reporterId: user.id,
        reporterName: user.nickname || user.username || user.id,
        reporterAvatarUrl: user.avatarUrl,
        reporterPlayerId: user.playerId ?? null,
        ratingId,
        levelId,
        note: typeof req.body?.note === 'string' ? req.body.note : undefined,
      });
      return res.json({ok: true, delivered: true});
    } catch (error: any) {
      const status = error?.status || 500;
      if (status === 503) {
        return res.status(503).json({error: 'Report webhook is not configured', delivered: false});
      }
      logger.error('Error sending curation Zen media report:', error);
      return res.status(500).json({error: 'Failed to send report'});
    }
  },
);

router.get(
  '/zen/session',
  Auth.user(),
  ApiDoc({
    operationId: 'getAdminCurationRatingZenSession',
    summary: 'Load saved curation Zen Mode session',
    tags: ['Admin', 'Curation Rating'],
    responses: {200: {description: 'Zen session or null'}, ...standardErrorResponses},
  }),
  async (req: Request, res: Response) => {
    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json({error: 'User not found'});
      }
      if (hasFlag(user, permissionFlags.RATING_BANNED)) {
        return res.status(403).json({error: 'User is banned from rating'});
      }
      const session = await getHydratedZenCurationSession(user.id);
      return res.json({session});
    } catch (error) {
      logger.error('Error loading curation Zen session:', error);
      return res.status(500).json({error: 'Failed to load Zen session'});
    }
  },
);

router.put(
  '/zen/session',
  Auth.user(),
  ApiDoc({
    operationId: 'putAdminCurationRatingZenSession',
    summary: 'Save curation Zen Mode session',
    tags: ['Admin', 'Curation Rating'],
    security: ['bearerAuth'],
    requestBody: {
      required: true,
      schema: {type: 'object', additionalProperties: true},
    },
    responses: {200: {description: 'Saved Zen session'}, ...standardErrorResponses},
  }),
  async (req: Request, res: Response) => {
    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json({error: 'User not found'});
      }
      if (hasFlag(user, permissionFlags.RATING_BANNED)) {
        return res.status(403).json({error: 'User is banned from rating'});
      }
      const payload = await upsertZenCurationSession(user.id, req.body);
      return res.json({session: payload});
    } catch (error) {
      if (error instanceof ZenSessionError) {
        return res.status(error.status).json({error: error.message});
      }
      logger.error('Error saving curation Zen session:', error);
      return res.status(500).json({error: 'Failed to save Zen session'});
    }
  },
);

router.delete(
  '/zen/session',
  Auth.user(),
  ApiDoc({
    operationId: 'deleteAdminCurationRatingZenSession',
    summary: 'Discard curation Zen Mode session',
    tags: ['Admin', 'Curation Rating'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Zen session discarded'}, ...standardErrorResponses},
  }),
  async (req: Request, res: Response) => {
    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json({error: 'User not found'});
      }
      await deleteZenCurationSession(user.id);
      return res.json({ok: true});
    } catch (error) {
      logger.error('Error deleting curation Zen session:', error);
      return res.status(500).json({error: 'Failed to discard Zen session'});
    }
  },
);

router.get(
  '/by-level/:levelId',
  Auth.addUserToRequest(),
  ApiDoc({
    operationId: 'getAdminCurationRatingByLevelId',
    summary: 'Pending curation rating by level id',
    tags: ['Admin', 'Curation Rating'],
    params: {levelId: stringIdParamSpec},
    responses: {200: {description: 'Curation rating'}, ...standardErrorResponses401404500},
  }),
  async (req: Request, res: Response) => {
    try {
      const levelId = parseInt(String(req.params.levelId), 10);
      if (!Number.isFinite(levelId) || levelId <= 0) {
        return res.status(400).json({error: 'Invalid level id'});
      }
      const rating = await buildCompleteCurationRatingByLevelId(levelId);
      if (!rating) {
        return res.status(404).json({error: 'Curation rating not found'});
      }
      return res.json(rating);
    } catch (error) {
      logger.error('Error fetching curation rating by level:', error);
      return res.status(500).json({error: 'Internal Server Error'});
    }
  },
);

router.post(
  '/:id([0-9]+)/discord',
  Auth.verified(),
  ApiDoc({
    operationId: 'postCurationRatingDiscordThread',
    summary: 'Create, close, or reopen a Discord vote thread for a curation rating',
    description: 'Body: {action: create|close|reopen, ping?: boolean}. Super admin. Closing returns the chart to website rating.',
    tags: ['Admin', 'Curation Rating'],
    security: ['bearerAuth'],
    params: {id: stringIdParamSpec},
    responses: {200: {description: 'Discord thread updated'}, ...standardErrorResponses},
  }),
  async (req: Request, res: Response) => {
    try {
      if (!req.user) {
        return res.status(401).json({error: 'User not found'});
      }
      const {action, ping} = readRatingThreadRequest(req.body);
      const rating = await manageCurationDiscordThread(req.user, Number(req.params.id), action, ping);
      return res.json({rating});
    } catch (error) {
      if (error instanceof LevelRequestError) {
        return res.status(error.status).json({error: error.message, code: error.code});
      }
      logger.error('Error updating a curation Discord thread:', error);
      return res.status(500).json({error: 'Failed to update the Discord thread'});
    }
  },
);

router.get(
  '/:id',
  Auth.addUserToRequest(),
  ApiDoc({
    operationId: 'getAdminCurationRatingById',
    summary: 'Curation rating by id',
    tags: ['Admin', 'Curation Rating'],
    params: {id: stringIdParamSpec},
    responses: {200: {description: 'Curation rating'}, ...standardErrorResponses401404500},
  }),
  async (req: Request, res: Response) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({error: 'Invalid curation rating id'});
      }
      const rating = await buildCompleteCurationRatingById(id);
      if (!rating) {
        return res.status(404).json({error: 'Curation rating not found'});
      }
      return res.json(rating);
    } catch (error) {
      logger.error('Error fetching curation rating by id:', error);
      return res.status(500).json({error: 'Internal Server Error'});
    }
  },
);

async function upsertOwnPicks(
  ratingId: number,
  userId: string,
  body: Record<string, unknown>,
  transaction: import('sequelize').Transaction,
) {
  const picks = await assertCurationRatingPicks(parseCurationRatingPicks(body), transaction);
  const commentRaw = typeof body.comment === 'string' ? body.comment : '';
  if (commentRaw.length > MAX_COMMENT_LENGTH) {
    throw new CurationRatingPickError(400, `Comment must not exceed ${MAX_COMMENT_LENGTH} characters`);
  }

  if (picksAreEmpty(picks)) {
    await CurationRatingDetail.destroy({
      where: {curationRatingId: ratingId, userId},
      transaction,
    });
    return picks;
  }

  await CurationRatingDetail.upsert(
    {
      curationRatingId: ratingId,
      userId,
      chartTypeId: picks.chartTypeId,
      vfxTypeId: picks.vfxTypeId,
      miscTypeIds: picks.miscTypeIds,
      comment: commentRaw,
    },
    {transaction},
  );
  return picks;
}

router.put(
  '/:id',
  Auth.verified(),
  ApiDoc({
    operationId: 'putAdminCurationRating',
    summary: 'Save curation rating picks',
    description: 'Body: chartTypeId, vfxTypeId, miscTypeIds, comment. Empty picks delete the detail.',
    tags: ['Admin', 'Curation Rating'],
    security: ['bearerAuth'],
    params: {id: stringIdParamSpec},
    responses: {200: {description: 'Curation rating updated'}, ...standardErrorResponses},
  }),
  async (req: Request, res: Response) => {
    let transaction: any;
    try {
      if (!req.user) {
        return res.status(401).json({error: 'User not found'});
      }
      if (hasFlag(req.user, permissionFlags.RATING_BANNED)) {
        return res.status(403).json({error: 'User is banned from rating'});
      }
      if (!canSaveCurationRating(req.user)) {
        return res.status(403).json({error: 'Rater or curator access required'});
      }

      const id = parseInt(String(req.params.id), 10);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({error: 'Invalid curation rating id'});
      }

      transaction = await sequelize.transaction();
      const locked = await CurationRating.findByPk(id, {transaction});
      if (!locked) {
        await safeTransactionRollback(transaction);
        return res.status(404).json({error: 'Curation rating not found'});
      }
      if (locked.confirmedAt != null) {
        await safeTransactionRollback(transaction);
        return res.status(409).json({error: 'Cannot change picks after a level has been settled'});
      }
      if (await isLockedCurationVote(locked, transaction)) {
        await safeTransactionRollback(transaction);
        return res.status(403).json({
          error: 'Vote cards are settled from Discord and cannot be rated on the site',
        });
      }

      const body = req.body as Record<string, unknown>;
      const ratedInZen = readRatedInZen(body);
      try {
        if (ratedInZen) {
          await assertZenCurationSubmitAllowed(req.user.id, id);
        } else {
          await assertNormalCurationRatingAllowed(req.user.id);
        }
      } catch (error) {
        await safeTransactionRollback(transaction);
        if (error instanceof ZenSessionError) {
          return res.status(error.status).json({error: error.message});
        }
        throw error;
      }

      await upsertOwnPicks(id, req.user.id, body, transaction);
      await transaction.commit();

      return res.json({
        message: 'Curation rating updated successfully',
        listRow: await buildCompleteCurationRatingById(id),
        complete: await buildCompleteCurationRatingById(id),
      });
    } catch (error) {
      await safeTransactionRollback(transaction);
      if (error instanceof CurationRatingPickError) {
        return res.status(error.status).json({error: error.message});
      }
      logger.error('Error updating curation rating:', error);
      return res.status(500).json({error: 'Failed to update curation rating'});
    }
  },
);

router.delete(
  '/:id/detail/:userId',
  Auth.verified(),
  ApiDoc({
    operationId: 'deleteAdminCurationRatingDetail',
    summary: 'Delete a curation rating detail',
    tags: ['Admin', 'Curation Rating'],
    security: ['bearerAuth'],
    params: {id: stringIdParamSpec, userId: stringIdParamSpec},
    responses: {200: {description: 'Detail deleted'}, ...standardErrorResponses401404500},
  }),
  async (req: Request, res: Response) => {
    let transaction: any;
    try {
      if (!req.user) {
        return res.status(401).json({error: 'User not authenticated'});
      }
      const id = parseInt(String(req.params.id), 10);
      const userId = String(req.params.userId);
      const isOwn = req.user.id === userId;
      if (!isOwn && !hasFlag(req.user, permissionFlags.SUPER_ADMIN)) {
        return res.status(403).json({error: 'Super admin access required'});
      }
      if (isOwn && !canSaveCurationRating(req.user)) {
        return res.status(403).json({error: 'Rater or curator access required'});
      }

      transaction = await sequelize.transaction();
      const locked = await CurationRating.findByPk(id, {transaction});
      if (!locked || locked.confirmedAt != null) {
        await safeTransactionRollback(transaction);
        return res.status(locked?.confirmedAt ? 409 : 404).json({
          error: locked?.confirmedAt ? 'Cannot change picks after settle' : 'Curation rating not found',
        });
      }
      if (await isLockedCurationVote(locked, transaction)) {
        await safeTransactionRollback(transaction);
        return res.status(403).json({
          error: 'Vote cards are settled from Discord and cannot be rated on the site',
        });
      }
      await CurationRatingDetail.destroy({
        where: {curationRatingId: id, userId},
        transaction,
      });
      await transaction.commit();
      return res.json({
        message: 'Curation rating detail deleted',
        listRow: await buildCompleteCurationRatingById(id),
        complete: await buildCompleteCurationRatingById(id),
      });
    } catch (error) {
      await safeTransactionRollback(transaction);
      logger.error('Error deleting curation rating detail:', error);
      return res.status(500).json({error: 'Failed to delete curation rating detail'});
    }
  },
);

router.post(
  '/:id/settle',
  Auth.verified(),
  ApiDoc({
    operationId: 'postAdminCurationRatingSettle',
    summary: 'Settle published curation types from the popup',
    description:
      'Writes the posted chart/vfx/misc picks onto the level, saves the reason, closes the queue, and enqueues the announcement. Does not store the actor’s personal vote.',
    tags: ['Admin', 'Curation Rating'],
    security: ['bearerAuth'],
    params: {id: stringIdParamSpec},
    responses: {200: {description: 'Settled'}, ...standardErrorResponses},
  }),
  async (req: Request, res: Response) => {
    let transaction: any;
    try {
      if (!req.user) {
        return res.status(401).json({error: 'User not found'});
      }
      if (!canSettleCurationRating(req.user)) {
        return res.status(403).json({error: 'Curator access required'});
      }

      const id = parseInt(String(req.params.id), 10);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({error: 'Invalid curation rating id'});
      }

      transaction = await sequelize.transaction();
      const locked = await CurationRating.findByPk(id, {transaction});
      if (!locked) {
        await safeTransactionRollback(transaction);
        return res.status(404).json({error: 'Curation rating not found'});
      }
      if (locked.confirmedAt != null) {
        await safeTransactionRollback(transaction);
        return res.status(409).json({error: 'This curation rating is already settled'});
      }
      if (await isLockedCurationVote(locked, transaction)) {
        await safeTransactionRollback(transaction);
        return res.status(403).json({
          error: 'Close the Discord thread before settling on the site',
        });
      }

      const level = await Level.findByPk(locked.levelId, {transaction, lock: true});
      if (!level) {
        await safeTransactionRollback(transaction);
        return res.status(404).json({error: 'Level not found'});
      }

      const body = req.body as Record<string, unknown>;
      const picks = await assertCurationRatingPicks(parseCurationRatingPicks(body), transaction);
      if (collectedTypeIds(picks).length === 0) {
        await safeTransactionRollback(transaction);
        return res.status(400).json({error: 'Settle requires at least one curation type'});
      }

      const reasonRaw =
        typeof body.curationRerateReason === 'string'
          ? body.curationRerateReason
          : typeof body.reason === 'string'
            ? body.reason
            : level.curationRerateReason;
      await level.update(
        {curationRerateReason: sanitizeTextInput(reasonRaw)},
        {transaction},
      );

      const flow = parseCurationFlow(level.curationFlow);
      const {previousTypeIds, typeIds} = await replaceLevelCurationTypes(
        locked.levelId,
        picks,
        req.user.id,
        transaction,
      );
      await confirmOpenCurationRating(locked.levelId, transaction, req.user.id);
      await closeCurationQueue(locked.levelId, transaction);
      await enqueueCurationAnnouncement({
        levelId: locked.levelId,
        kind: curationAnnouncementKind(flow),
        beforeTypeIds: previousTypeIds,
        afterTypeIds: typeIds,
        enqueuedBy: req.user.id,
        transaction,
      });
      await completeLevelRequestForSettledCuration(locked.levelId, transaction, req.user.id);
      await transaction.commit();
      await elasticsearchService.indexLevel(locked.levelId);

      return res.json({
        message: 'Curation rating settled',
        settled: true,
        levelId: locked.levelId,
      });
    } catch (error) {
      await safeTransactionRollback(transaction);
      if (error instanceof CurationRatingPickError) {
        return res.status(error.status).json({error: error.message});
      }
      logger.error('Error settling curation rating:', error);
      return res.status(500).json({error: 'Failed to settle curation rating'});
    }
  },
);

export default router;
