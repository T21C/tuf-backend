import { Request } from 'express';
import { Transaction } from 'sequelize';
import sequelize from '@/config/db.js';
import Difficulty from '@/models/levels/Difficulty.js';
import Level from '@/models/levels/Level.js';
import LevelRerateHistory from '@/models/levels/LevelRerateHistory.js';
import LevelTag from '@/models/levels/LevelTag.js';
import Rating from '@/models/levels/Rating.js';
import RatingDetail from '@/models/levels/RatingDetail.js';
import type { UserAttributes } from '@/models/auth/User.js';
import { permissionFlags } from '@/config/constants.js';
import { canApplyAutoRank, hasFlag } from '@/misc/utils/auth/permissionUtils.js';
import { isDiscordVoteCard } from '@/misc/utils/data/RatingUtils.js';
import { autoraterVoteText, evaluateRatingFlow } from '@/misc/utils/data/ratingFlow.js';
import { sseManager, SSE_SOURCES } from '@/misc/utils/server/sse.js';
import { safeTransactionRollback } from '@/misc/utils/Utility.js';
import { CacheInvalidation } from '@/server/middleware/cache.js';
import { syncAnnouncementQueueAfterLevelSave } from '@/server/services/announcements/levelAnnouncementQueue.js';
import { logger } from '@/server/services/core/LoggerService.js';
import ElasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';
import { notifyChartRated } from '@/server/services/notifications/chartOwnerNotify.js';
import { invalidateRatingAccuracyCache, freezeAndUpsertRating } from '@/server/services/ratings/ratingAccuracyService.js';
import {
  broadcastRatingUpsert,
  buildCompleteRatingById,
  buildLevelUpdateSseData,
} from '@/server/services/ratings/ratingListService.js';
import {
  executeLevelPassScoreRecalc,
  handleRatingChanges,
} from '@/server/routes/v2/database/levels/modification.js';

const elasticsearchService = ElasticsearchService.getInstance();
const MAX_BLOCK_REASON = 500;

export class RatingActionError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'RatingActionError';
  }
}

export async function settleExactFlow1(ratingId: number, actor: UserAttributes) {
  if (hasFlag(actor, permissionFlags.RATING_BANNED)) {
    throw new RatingActionError('User is banned from rating', 403);
  }
  if (!canApplyAutoRank(actor)) {
    throw new RatingActionError('Only raters can settle an exact match', 403);
  }

  const loaded = await loadOpenRating(ratingId);
  const decision = await decisionFor(loaded);
  if (decision.settleActor !== 'rater' || !decision.suggestedDiffName) {
    throw new RatingActionError('This card is not an exact match a rater can settle', 403);
  }
  const difficulties = await Difficulty.findAll({
    attributes: ['id', 'name', 'type', 'sortOrder', 'baseScore'],
  });
  const target = difficulties.find((row) => row.name === decision.suggestedDiffName);
  if (!target) {
    throw new RatingActionError('Suggested difficulty is missing', 409);
  }

  let transaction: Transaction | undefined;
  try {
    transaction = await sequelize.transaction();
    const locked = await Level.findByPk(loaded.level.id, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!locked || !locked.toRate) {
      throw new RatingActionError('Rating is no longer open', 409);
    }

    const fakeReq = {
      body: { toRate: false, diffId: target.id, rerateNum: locked.rerateNum },
      user: { id: actor.id },
    } as Request;
    const { settledRatingId } = await handleRatingChanges(locked, fakeReq, transaction);
    if (!settledRatingId) {
      throw new RatingActionError('No open rating to settle', 409);
    }

    const previousDiffId = locked.diffId;
    const previousBaseScore = locked.baseScore || 0;
    const nextBaseScore = target.baseScore || 0;
    await Level.update(
      {
        diffId: target.id,
        baseScore: nextBaseScore,
        previousDiffId,
        previousBaseScore,
        toRate: false,
      },
      { where: { id: locked.id }, transaction },
    );
    await freezeAndUpsertRating(
      settledRatingId,
      { settledDiffId: target.id, clearsAtSettle: locked.clears ?? 0 },
      transaction,
    );
    if (previousDiffId !== 0) {
      await LevelRerateHistory.create(
        {
          levelId: locked.id,
          previousDiffId,
          newDiffId: target.id,
          previousBaseScore,
          newBaseScore: nextBaseScore,
          reratedBy: actor.id,
          createdAt: new Date(),
        },
        { transaction },
      );
    }

    const updated = await Level.findByPk(locked.id, {
      include: [{ model: Difficulty, as: 'difficulty', required: false }],
      transaction,
    });
    if (updated) {
      await notifyChartRated({
        level: { id: locked.id, song: updated.song ?? locked.song, artist: updated.artist ?? locked.artist },
        difficultyName: updated.difficulty?.name?.trim() || target.name,
        ratingId: settledRatingId,
        actorId: actor.id,
        transaction,
      });
      await syncAnnouncementQueueAfterLevelSave({
        oldLevel: locked,
        newLevel: updated,
        toRateTransition: false,
        enqueuedBy: actor.id,
        transaction,
      });
    }
    await transaction.commit();
    transaction = undefined;

    await invalidateRatingAccuracyCache().catch((error) => {
      logger.error('rating accuracy cache invalidation failed after settle', error);
    });
    void executeLevelPassScoreRecalc(locked.id, {
      diffId: target.id,
      baseScore: nextBaseScore,
    }).catch((error) => {
      logger.error('pass score recalc failed after rater settle', error);
    });
    await elasticsearchService.indexLevel(locked.id);
    await CacheInvalidation.invalidateTag('admin:ratings').catch((error) => {
      logger.error('admin ratings cache invalidation failed after settle', error);
    });
    sseManager.broadcastToSources([SSE_SOURCES.rating], {
      type: 'levelUpdate',
      data: await buildLevelUpdateSseData(locked.id),
    });
    await broadcastRatingUpsert(ratingId, locked.id);
    return buildCompleteRatingById(ratingId);
  } catch (error) {
    await safeTransactionRollback(transaction);
    throw error;
  }
}

export async function blockAutoRank(ratingId: number, actor: UserAttributes, reason: unknown) {
  if (hasFlag(actor, permissionFlags.RATING_BANNED)) {
    throw new RatingActionError('User is banned from rating', 403);
  }
  if (!canApplyAutoRank(actor)) {
    throw new RatingActionError('Only raters can block auto rank', 403);
  }
  const note = typeof reason === 'string' ? reason.trim().slice(0, MAX_BLOCK_REASON) : '';
  const rating = await Rating.findByPk(ratingId);
  if (!rating) throw new RatingActionError('Rating not found', 404);
  if (rating.confirmedAt != null) throw new RatingActionError('Rating is already settled', 409);
  if (rating.autoRankBlockedBy) throw new RatingActionError('Auto rank is already blocked', 409);

  await rating.update({
    autoRankBlockedBy: actor.id,
    autoRankBlockReason: note,
    autoRankBlockedAt: new Date(),
  });
  await CacheInvalidation.invalidateTag('admin:ratings').catch(() => undefined);
  await broadcastRatingUpsert(ratingId, rating.levelId);
  return buildCompleteRatingById(ratingId);
}

export async function unblockAutoRank(ratingId: number, actor: UserAttributes) {
  if (!hasFlag(actor, permissionFlags.SUPER_ADMIN)) {
    throw new RatingActionError('Only a super admin can unblock auto rank', 403);
  }
  const rating = await Rating.findByPk(ratingId);
  if (!rating) throw new RatingActionError('Rating not found', 404);
  await rating.update({
    autoRankBlockedBy: null,
    autoRankBlockReason: null,
    autoRankBlockedAt: null,
  });
  await CacheInvalidation.invalidateTag('admin:ratings').catch(() => undefined);
  await broadcastRatingUpsert(ratingId, rating.levelId);
  return buildCompleteRatingById(ratingId);
}

async function loadOpenRating(ratingId: number) {
  const rating = await Rating.findByPk(ratingId, {
    include: [
      { model: RatingDetail, as: 'details', required: false },
      {
        model: Level,
        as: 'level',
        required: true,
        include: [
          { model: Difficulty, as: 'difficulty', required: false },
          { model: LevelTag, as: 'tags', required: false, through: { attributes: [] } },
        ],
      },
    ],
  });
  if (!rating || !rating.level) throw new RatingActionError('Rating not found', 404);
  if (rating.confirmedAt != null || !rating.level.toRate) {
    throw new RatingActionError('Rating is already settled', 409);
  }
  return { rating, level: rating.level };
}

async function decisionFor(loaded: Awaited<ReturnType<typeof loadOpenRating>>) {
  const { rating, level } = loaded;
  const difficulties = await Difficulty.findAll({
    attributes: ['id', 'name', 'type', 'sortOrder'],
  });
  const autoraterUserId = process.env.AUTORATER_UUID ?? null;
  const details = (rating.details || []).map((detail) => ({
    id: detail.id,
    userId: detail.userId,
    rating: detail.rating,
    isCommunityRating: detail.isCommunityRating,
  }));
  return evaluateRatingFlow({
    diffId: level.diffId,
    diffName: level.difficulty?.name ?? null,
    clears: level.clears ?? 0,
    rerateNum: level.rerateNum,
    isDiscordVote: isDiscordVoteCard({
      rerateNum: level.rerateNum,
      requesterFR: rating.requesterFR,
      discordMessageUrl: rating.discordMessageUrl,
      discordThreadClosed: rating.discordThreadClosed,
    }),
    combinedTier: autoraterVoteText(details, autoraterUserId, rating.autoraterCombined),
    details,
    autoraterUserId,
    tags: (level.tags || []).map((tag) => ({ name: tag.name })),
    manuallyBlocked: Boolean(rating.autoRankBlockedBy),
    difficulties: difficulties.map((row) => ({
      id: row.id,
      name: row.name,
      type: row.type,
      sortOrder: row.sortOrder,
    })),
  });
}
