import {getSequelizeForModelGroup} from '@/config/db.js';
import CurationRating from '@/models/curations/CurationRating.js';
import Level from '@/models/levels/Level.js';
import {logger} from '@/server/services/core/LoggerService.js';
import {CacheInvalidation} from '@/server/middleware/cache.js';
import {safeTransactionRollback, sanitizeTextInput} from '@/misc/utils/Utility.js';
import {hasFlag} from '@/misc/utils/auth/permissionUtils.js';
import {permissionFlags} from '@/config/constants.js';
import {LevelRequestError} from '@/server/services/requests/levelRequestService.js';
import {
  voteThreadLabel,
  websiteRatingLabel,
  type RatingThreadLifecycle,
} from '@/misc/utils/data/ratingThread.js';
import {logRatingThreadFailure} from '@/server/services/discord/discordWebhook.js';
import {
  closeCurationThread,
  createCurationThread,
  reopenCurationThread,
} from '@/server/services/discord/curationThread.js';
import {buildCompleteCurationRatingById} from '@/server/services/curations/curationRatingListService.js';
import ElasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';

const sequelize = getSequelizeForModelGroup('curations');
const elasticsearchService = ElasticsearchService.getInstance();

type Actor = {id: string; permissionFlags?: bigint | number | string | null};

function isSuperAdmin(user: Actor | null | undefined): boolean {
  if (!user) return false;
  try {
    return hasFlag(BigInt(user.permissionFlags ?? 0), permissionFlags.SUPER_ADMIN);
  } catch {
    return false;
  }
}

async function publish(ratingId: number, levelId: number) {
  await CacheInvalidation.invalidateTag('admin:curation-ratings').catch((error) => {
    logger.error('Failed to invalidate curation rating cache after a Discord thread change', error);
  });
  try {
    await elasticsearchService.reindexLevels([levelId]);
  } catch (error) {
    logger.error('Failed to reindex after a curation Discord thread change', error);
  }
  return buildCompleteCurationRatingById(ratingId);
}

async function loadOpen(user: Actor, ratingId: number) {
  if (!user?.id) throw new LevelRequestError(401, 'auth', 'Authentication required');
  if (!isSuperAdmin(user)) {
    throw new LevelRequestError(403, 'forbidden', 'Super admin access required');
  }
  const rating = await CurationRating.findByPk(ratingId);
  if (!rating) throw new LevelRequestError(404, 'missing', 'Curation rating not found');
  if (rating.confirmedAt != null) {
    throw new LevelRequestError(409, 'settled', 'This curation rating is already settled');
  }
  const level = await Level.findByPk(rating.levelId);
  if (!level) throw new LevelRequestError(404, 'missing_level', 'Level not found');
  if (level.isDeleted) throw new LevelRequestError(400, 'deleted', 'Deleted levels cannot be posted');
  if (level.isHidden) throw new LevelRequestError(400, 'hidden', 'Hidden levels cannot be posted');
  if (!level.toCuration) {
    throw new LevelRequestError(400, 'unsettled', 'This level is not on the curation page');
  }
  return {rating, level, actorUserId: user.id};
}

async function applyVoteLabel(level: Level, mode: 'discord' | 'website') {
  const labeled = mode === 'discord'
    ? voteThreadLabel(level.curationRerateNum || '')
    : websiteRatingLabel(level.curationRerateNum || '');
  await level.update({curationRerateNum: sanitizeTextInput(labeled)});
  return labeled;
}

export async function manageCurationDiscordThread(
  user: Actor,
  ratingId: number,
  action: RatingThreadLifecycle,
  ping: boolean,
) {
  if (action === 'close') return closeManualThread(user, ratingId, ping);
  if (action === 'reopen') return reopenManualThread(user, ratingId, ping);
  return createManualThread(user, ratingId, ping);
}

async function createManualThread(user: Actor, ratingId: number, ping: boolean) {
  const {rating, level, actorUserId} = await loadOpen(user, ratingId);
  if (rating.discordMessageUrl) {
    throw new LevelRequestError(409, 'discord', 'This curation rating already has a Discord thread');
  }
  const transaction = await sequelize.transaction();
  let labeled = '';
  let reason = '';
  let levelId = level.id;
  try {
    const lockedRating = await CurationRating.findByPk(ratingId, {transaction, lock: true});
    const lockedLevel = await Level.findByPk(level.id, {transaction, lock: true});
    if (!lockedRating || !lockedLevel) {
      throw new LevelRequestError(404, 'missing', 'Curation rating not found');
    }
    labeled = voteThreadLabel(lockedLevel.curationRerateNum || '');
    reason = lockedLevel.curationRerateReason || '';
    levelId = lockedLevel.id;
    await lockedLevel.update({curationRerateNum: labeled}, {transaction});
    await lockedRating.update({discordPostError: null, discordThreadClosed: false}, {transaction});
    await transaction.commit();
  } catch (error) {
    await safeTransactionRollback(transaction);
    throw error;
  }

  try {
    const posted = await createCurationThread({
      levelId,
      reason,
      actorUserId,
      embedTitle: `Curation #${ratingId}`,
      ping,
    });
    await CurationRating.update(
      {discordMessageUrl: posted.url, discordPostError: null, discordThreadClosed: false},
      {where: {id: ratingId}},
    );
    return publish(ratingId, levelId);
  } catch (error) {
    const message = logRatingThreadFailure(ratingId, error);
    await CurationRating.update({discordPostError: message}, {where: {id: ratingId}});
    await publish(ratingId, levelId);
    throw new LevelRequestError(502, 'discord', message);
  }
}

async function closeManualThread(user: Actor, ratingId: number, ping: boolean) {
  const {rating, level, actorUserId} = await loadOpen(user, ratingId);
  if (!rating.discordMessageUrl) {
    throw new LevelRequestError(409, 'discord', 'This curation rating has no Discord thread');
  }
  if (rating.discordThreadClosed) {
    throw new LevelRequestError(409, 'discord', 'This Discord thread is already closed');
  }
  let outcome: 'closed' | 'missing';
  try {
    outcome = await closeCurationThread({
      threadUrl: rating.discordMessageUrl,
      actorUserId,
      ping,
    });
  } catch (error) {
    const message = logRatingThreadFailure(ratingId, error);
    await CurationRating.update({discordPostError: message}, {where: {id: ratingId}});
    throw new LevelRequestError(502, 'discord', message);
  }
  await applyVoteLabel(level, 'website');
  const url = outcome === 'missing' ? null : rating.discordMessageUrl;
  await rating.update({
    discordMessageUrl: url,
    discordThreadClosed: true,
    discordPostError: null,
  });
  return publish(rating.id, level.id);
}

async function reopenManualThread(user: Actor, ratingId: number, ping: boolean) {
  const {rating, level, actorUserId} = await loadOpen(user, ratingId);
  if (!rating.discordMessageUrl || !rating.discordThreadClosed) {
    throw new LevelRequestError(409, 'discord', 'This curation rating has no closed Discord thread to reopen');
  }
  try {
    const outcome = await reopenCurationThread({
      threadUrl: rating.discordMessageUrl,
      actorUserId,
      ping,
    });
    if (outcome === 'missing') throw new Error('Discord thread no longer exists');
  } catch (error) {
    const message = logRatingThreadFailure(ratingId, error);
    await CurationRating.update({discordPostError: message}, {where: {id: ratingId}});
    throw new LevelRequestError(502, 'discord', message);
  }
  await applyVoteLabel(level, 'discord');
  await rating.update({discordThreadClosed: false, discordPostError: null});
  return publish(rating.id, level.id);
}
