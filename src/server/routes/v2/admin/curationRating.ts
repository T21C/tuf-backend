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
import {safeTransactionRollback} from '@/misc/utils/Utility.js';
import {hasAnyFlag, hasFlag} from '@/misc/utils/auth/permissionUtils.js';
import {permissionFlags} from '@/config/constants.js';
import CurationRating from '@/models/curations/CurationRating.js';
import CurationRatingDetail from '@/models/curations/CurationRatingDetail.js';
import ElasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';
import {
  assertCurationRatingPicks,
  collectedTypeIds,
  CurationRatingPickError,
  parseCurationRatingPicks,
  picksAreEmpty,
} from '@/misc/utils/data/curationRatingPicks.js';
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

      await upsertOwnPicks(id, req.user.id, req.body as Record<string, unknown>, transaction);
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
    summary: 'Settle curation types from the current picks',
    description: 'Writes the posted chart/vfx/misc picks onto the level curation and closes the queue.',
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

      const picks = await assertCurationRatingPicks(
        parseCurationRatingPicks(req.body as Record<string, unknown>),
        transaction,
      );
      if (collectedTypeIds(picks).length === 0) {
        await safeTransactionRollback(transaction);
        return res.status(400).json({error: 'Settle requires at least one curation type'});
      }

      await upsertOwnPicks(id, req.user.id, req.body as Record<string, unknown>, transaction);
      await replaceLevelCurationTypes(locked.levelId, picks, req.user.id, transaction);
      await confirmOpenCurationRating(locked.levelId, transaction, req.user.id);
      await closeCurationQueue(locked.levelId, transaction);
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
