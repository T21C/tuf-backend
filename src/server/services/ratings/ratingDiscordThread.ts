import {getSequelizeForModelGroup} from '@/config/db.js';
import Rating from '@/models/levels/Rating.js';
import Level from '@/models/levels/Level.js';
import LevelRequest from '@/models/levels/LevelRequest.js';
import {logger} from '@/server/services/core/LoggerService.js';
import {CacheInvalidation} from '@/server/middleware/cache.js';
import {safeTransactionRollback} from '@/misc/utils/Utility.js';
import {sseManager, SSE_SOURCES} from '@/misc/utils/server/sse.js';
import {collectLevelReferenceIds} from '@/misc/utils/data/levelRequestValidation.js';
import type {RatingThreadLifecycle} from '@/misc/utils/data/ratingThread.js';
import {
  broadcastRatingUpsert,
  buildCompleteRatingById,
  buildLevelUpdateSseData,
} from '@/server/services/ratings/ratingListService.js';
import ElasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';
import {
  canManageRequestType,
  LevelRequestError,
} from '@/server/services/requests/levelRequestService.js';
import {
  applyRatingThreadMode,
  closeRatingThread,
  createRatingThread,
  logRatingThreadFailure,
  reopenRatingThread,
  voteThreadLabel,
} from '@/server/services/discord/ratingThread.js';

const sequelize = getSequelizeForModelGroup('levels');
const elasticsearchService = ElasticsearchService.getInstance();

type Actor = Parameters<typeof canManageRequestType>[0];

async function refreshLevelSurfaces(levelId: number) {
  try {
    await elasticsearchService.reindexLevels([levelId]);
    sseManager.broadcastToSources([SSE_SOURCES.rating], {
      type: 'levelUpdate',
      data: await buildLevelUpdateSseData(levelId),
    });
  } catch (error) {
    logger.error('Failed to refresh rating surfaces after a Discord thread change', error);
  }
}

async function publishRating(ratingId: number, levelId: number) {
  await CacheInvalidation.invalidateTag('admin:ratings').catch((error) => {
    logger.error('Failed to invalidate rating cache after a Discord thread change', error);
  });
  await broadcastRatingUpsert(ratingId, levelId);
}

async function loadManualRating(user: Actor, ratingId: number) {
  if (!user?.id) {
    throw new LevelRequestError(401, 'auth', 'Authentication required');
  }
  if (!canManageRequestType(user, 'rerate')) {
    throw new LevelRequestError(403, 'forbidden', 'You cannot manage Discord threads for ratings');
  }
  const rating = await Rating.findByPk(ratingId);
  if (!rating) throw new LevelRequestError(404, 'missing', 'Rating not found');
  if (rating.confirmedAt != null) {
    throw new LevelRequestError(409, 'settled', 'This rating is already settled');
  }
  const linked = await LevelRequest.findOne({
    where: {linkedRatingId: rating.id, type: 'rerate'},
    attributes: ['id'],
  });
  if (linked) {
    throw new LevelRequestError(409, 'request', 'This rating comes from a website request');
  }
  const level = await Level.findByPk(rating.levelId);
  if (!level) throw new LevelRequestError(404, 'missing_level', 'Level not found');
  if (level.isDeleted) throw new LevelRequestError(400, 'deleted', 'Deleted levels cannot be posted');
  if (level.isHidden) throw new LevelRequestError(400, 'hidden', 'Hidden levels cannot be posted');
  if (!level.toRate) throw new LevelRequestError(400, 'unsettled', 'This level is not on the rating page');
  return {rating, level, actorUserId: user.id};
}

function stampThreadResult(
  complete: Record<string, unknown> | null,
  state: {requesterFR: string; rerateNum: string; url: string | null; closed: boolean; vote: boolean},
) {
  if (!complete) return complete;
  complete.requesterFR = state.requesterFR;
  complete.discordMessageUrl = state.url;
  complete.discordThreadClosed = state.closed;
  complete.discordPostError = null;
  complete.isDiscordVote = state.vote;
  if (complete.level && typeof complete.level === 'object') {
    (complete.level as Record<string, unknown>).rerateNum = state.rerateNum;
  }
  return complete;
}

async function finish(
  ratingId: number,
  levelId: number,
  state: {requesterFR: string; rerateNum: string; url: string | null; closed: boolean; vote: boolean},
) {
  await refreshLevelSurfaces(levelId);
  await publishRating(ratingId, levelId);
  return stampThreadResult(await buildCompleteRatingById(ratingId), state);
}

/** Discord vote thread for a rating an admin placed on the page, with no website request. */
export async function manageRatingDiscordThread(
  user: Actor,
  ratingId: number,
  action: RatingThreadLifecycle,
  ping = false,
) {
  if (action === 'close') return closeManualThread(user, ratingId, ping);
  if (action === 'reopen') return reopenManualThread(user, ratingId, ping);
  return createManualThread(user, ratingId, ping);
}

async function createManualThread(user: Actor, ratingId: number, ping: boolean) {
  if (!user?.id) throw new LevelRequestError(401, 'auth', 'Authentication required');
  if (!canManageRequestType(user, 'rerate')) {
    throw new LevelRequestError(403, 'forbidden', 'You cannot manage Discord threads for ratings');
  }
  const actorUserId = user.id;
  const transaction = await sequelize.transaction();
  let levelId = 0;
  let reason = '';
  let requested = '';
  let labeled = '';
  try {
    const rating = await Rating.findByPk(ratingId, {transaction, lock: true});
    if (!rating) throw new LevelRequestError(404, 'missing', 'Rating not found');
    if (rating.confirmedAt != null) {
      throw new LevelRequestError(409, 'settled', 'This rating is already settled');
    }
    if (rating.discordMessageUrl) {
      throw new LevelRequestError(409, 'discord', 'This rating already has a Discord thread');
    }
    const linked = await LevelRequest.findOne({
      where: {linkedRatingId: rating.id, type: 'rerate'},
      attributes: ['id'],
      transaction,
    });
    if (linked) {
      throw new LevelRequestError(409, 'request', 'This rating comes from a website request');
    }
    const level = await Level.findByPk(rating.levelId, {transaction, lock: true});
    if (!level) throw new LevelRequestError(404, 'missing_level', 'Level not found');
    if (level.isDeleted) throw new LevelRequestError(400, 'deleted', 'Deleted levels cannot be posted');
    if (level.isHidden) throw new LevelRequestError(400, 'hidden', 'Hidden levels cannot be posted');
    if (!level.toRate) throw new LevelRequestError(400, 'unsettled', 'This level is not on the rating page');
    const proposal = (level.rerateNum || rating.requesterFR || '').trim();
    if (!proposal) {
      throw new LevelRequestError(400, 'rating', 'Enter the requested rating before creating a Discord thread');
    }
    requested = proposal.trim().replace(/^\s*vote\b\s*/i, '').trim();
    labeled = voteThreadLabel(proposal);
    reason = level.rerateReason || '';
    levelId = level.id;
    await level.update({rerateNum: labeled}, {transaction});
    await rating.update({requesterFR: labeled, discordPostError: null, discordThreadClosed: false}, {transaction});
    await transaction.commit();
  } catch (error) {
    await safeTransactionRollback(transaction);
    throw error;
  }

  try {
    const posted = await createRatingThread({
      levelId,
      requestedRating: requested,
      reason,
      comparisonLevelIds: collectLevelReferenceIds(reason),
      actorUserId,
      embedTitle: `Rating #${ratingId}`,
      ping,
    });
    await Rating.update(
      {discordMessageUrl: posted.url, discordPostError: null, discordThreadClosed: false},
      {where: {id: ratingId}},
    );
    return finish(ratingId, levelId, {
      requesterFR: labeled,
      rerateNum: labeled,
      url: posted.url,
      closed: false,
      vote: true,
    });
  } catch (error) {
    const message = logRatingThreadFailure(ratingId, error);
    await Rating.update({discordPostError: message}, {where: {id: ratingId}});
    await publishRating(ratingId, levelId);
    throw new LevelRequestError(502, 'discord', message);
  }
}

async function closeManualThread(user: Actor, ratingId: number, ping: boolean) {
  const {rating, level, actorUserId} = await loadManualRating(user, ratingId);
  if (!rating.discordMessageUrl) {
    throw new LevelRequestError(409, 'discord', 'This rating has no Discord thread');
  }
  if (rating.discordThreadClosed) {
    throw new LevelRequestError(409, 'discord', 'This Discord thread is already closed');
  }
  let outcome: 'closed' | 'missing';
  try {
    outcome = await closeRatingThread({
      threadUrl: rating.discordMessageUrl,
      actorUserId,
      ping,
    });
  } catch (error) {
    const message = logRatingThreadFailure(ratingId, error);
    await Rating.update({discordPostError: message}, {where: {id: ratingId}});
    throw new LevelRequestError(502, 'discord', message);
  }
  const mode = await applyRatingThreadMode(level, rating, 'website');
  const url = outcome === 'missing' ? null : rating.discordMessageUrl;
  await rating.update({
    discordMessageUrl: url,
    discordThreadClosed: true,
    discordPostError: null,
  });
  return finish(rating.id, level.id, {
    requesterFR: mode.requesterFR,
    rerateNum: mode.rerateNum,
    url,
    closed: true,
    vote: false,
  });
}

async function reopenManualThread(user: Actor, ratingId: number, ping: boolean) {
  const {rating, level, actorUserId} = await loadManualRating(user, ratingId);
  if (!rating.discordMessageUrl || !rating.discordThreadClosed) {
    throw new LevelRequestError(409, 'discord', 'This rating has no closed Discord thread to reopen');
  }
  try {
    const outcome = await reopenRatingThread({
      threadUrl: rating.discordMessageUrl,
      actorUserId,
      ping,
    });
    if (outcome === 'missing') throw new Error('Discord thread no longer exists');
  } catch (error) {
    const message = logRatingThreadFailure(ratingId, error);
    await Rating.update({discordPostError: message}, {where: {id: ratingId}});
    throw new LevelRequestError(502, 'discord', message);
  }
  const mode = await applyRatingThreadMode(level, rating, 'discord');
  await rating.update({discordThreadClosed: false, discordPostError: null});
  return finish(rating.id, level.id, {
    requesterFR: mode.requesterFR,
    rerateNum: mode.rerateNum,
    url: rating.discordMessageUrl,
    closed: false,
    vote: true,
  });
}
