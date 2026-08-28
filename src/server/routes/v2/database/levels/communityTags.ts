import { Router, Request, Response } from 'express';
import type { Transaction } from 'sequelize';
import { Auth } from '@/server/middleware/auth.js';
import { ApiDoc } from '@/server/middleware/apiDoc.js';
import {
  errorResponseSchema,
  idParamSpec,
  standardErrorResponses404500,
  standardErrorResponses500,
} from '@/server/schemas/v2/database/levels/index.js';
import Level from '@/models/levels/Level.js';
import LevelTag from '@/models/levels/LevelTag.js';
import LevelTagAssignment from '@/models/levels/LevelTagAssignment.js';
import LevelTagGroup from '@/models/levels/LevelTagGroup.js';
import LevelTagVote from '@/models/levels/LevelTagVote.js';
import Difficulty from '@/models/levels/Difficulty.js';
import { TAG_GROUP_INCLUDE, TAG_LIST_ORDER, serializeLevelTag } from '@/server/services/data/levelTagGroupService.js';
import {
  countUniqueClears,
  loadPlayerTopPguDifficulty,
  rematerializeCommunityTagsForLevel,
  uniqueClearerUserIds,
  userHasClearerPass,
} from '@/server/services/data/communityTagVoteService.js';
import { getCommunityTagConfig } from '@/config/app.config.js';
import { voteWeightForClearer, wilsonLowerBound } from '@/misc/utils/data/communityTagScoring.js';
import {
  isTopPlayRequirementSatisfied,
  normalizeVoteAction,
  resolveCommunityTagSettings,
  tagAllowedForDifficulty,
  type CommunityTagVoteBlockReason,
} from '@/misc/utils/data/communityTagEligibility.js';
import { hasFlag } from '@/misc/utils/auth/permissionUtils.js';
import { permissionFlags } from '@/config/constants.js';
import { createRateLimiter } from '@/server/decorators/rateLimiter.js';
import { logger } from '@/server/services/core/LoggerService.js';
import sequelize from '@/config/db.js';
import { safeTransactionRollback } from '@/misc/utils/Utility.js';
import { CacheInvalidation } from '@/server/middleware/cache.js';
import ElasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';
import { invalidatePackLevelsCachesForLevelIds } from '@/server/services/packs/packDetailCacheService.js';

const router: Router = Router();

const communityTagVoteLimiter = createRateLimiter({
  type: 'community-tag-vote',
  windowMs: 60 * 1000,
  maxAttempts: 120,
  blockDuration: 2 * 60 * 1000,
  failClosed: false,
});

async function loadPguDifficulties() {
  return Difficulty.findAll({
    where: { type: 'PGU' },
    attributes: ['id', 'name', 'type', 'sortOrder'],
    order: [['sortOrder', 'ASC']],
  });
}

async function loadLevelWithDifficulty(levelId: number, transaction?: Transaction) {
  return Level.findByPk(levelId, {
    attributes: ['id', 'isDeleted', 'diffId'],
    include: [
      {
        model: Difficulty,
        as: 'difficulty',
        attributes: ['id', 'name', 'type', 'sortOrder'],
        required: false,
      },
    ],
    transaction,
  }) as Promise<(Level & { difficulty?: Difficulty | null }) | null>;
}

function voteBlockReason(opts: {
  user: Request['user'];
  isBanned: boolean;
  chartCleared: boolean;
  levelDeleted: boolean;
  bandOk: boolean;
  topPlayOk: boolean;
  scoringMode: 'wilson' | 'skillset';
  isClearer: boolean;
}): CommunityTagVoteBlockReason {
  if (opts.levelDeleted) return 'deleted';
  if (!opts.chartCleared) return 'uncleared';
  if (!opts.user) return 'login';
  if (opts.isBanned) return 'banned';
  if (!opts.bandOk) return 'band';
  if (!opts.topPlayOk) return 'topPlay';
  if (opts.scoringMode === 'skillset' && !opts.isClearer) return 'mustClear';
  return null;
}

async function loadCommunityTagVoteState(levelId: number, user: Request['user']) {
  const envKnobs = getCommunityTagConfig();
  const catalog = await LevelTag.findAll({
    where: { isCommunity: true },
    include: [TAG_GROUP_INCLUDE],
    order: TAG_LIST_ORDER,
  });

  const [assignments, votes, uniqueClears, pguDifficulties, level, clearerUserIds, isClearer, liveTopDiff] =
    await Promise.all([
      LevelTagAssignment.findAll({
        where: { levelId },
        attributes: ['tagId', 'pinned', 'score'],
      }),
      LevelTagVote.findAll({
        where: { levelId },
        attributes: ['tagId', 'userId', 'weight', 'direction'],
      }),
      countUniqueClears(levelId),
      loadPguDifficulties(),
      loadLevelWithDifficulty(levelId),
      uniqueClearerUserIds(levelId),
      user?.playerId != null ? userHasClearerPass(user.playerId, levelId) : Promise.resolve(false),
      user?.playerId != null ? loadPlayerTopPguDifficulty(user.playerId) : Promise.resolve(null),
    ]);

  const difficulty = level?.difficulty ?? null;
  const chartCleared = uniqueClears > 0;
  const isBanned = Boolean(
    user && (hasFlag(user, permissionFlags.TAG_VOTE_BANNED) || user.isTagVoteBanned),
  );
  const topPlayOk = isTopPlayRequirementSatisfied({
    levelDiff: difficulty,
    topDiff: liveTopDiff,
    pguDifficulties,
    hasClearOfThisLevel: isClearer,
  });

  const assignmentByTag = new Map(assignments.map((a) => [a.tagId, a]));
  const votesByTag = new Map<number, LevelTagVote[]>();
  const userVoteByTag = new Map<number, { weight: number; direction: number }>();

  for (const vote of votes) {
    const list = votesByTag.get(vote.tagId) ?? [];
    list.push(vote);
    votesByTag.set(vote.tagId, list);
    if (user?.id && vote.userId === user.id) {
      userVoteByTag.set(vote.tagId, { weight: vote.weight, direction: vote.direction });
    }
  }

  const tags = catalog
    .map((tag) => {
      const group = (tag as LevelTag & { tagGroup?: LevelTagGroup | null }).tagGroup ?? null;
      const settings = resolveCommunityTagSettings(tag, group, envKnobs);
      const bandOk = tagAllowedForDifficulty(settings.allowedBands, difficulty);
      if (!bandOk) return null;

      const assignment = assignmentByTag.get(tag.id);
      let upWeight = 0;
      let downWeight = 0;
      let voteCount = 0;
      for (const vote of votesByTag.get(tag.id) ?? []) {
        if (settings.scoringMode === 'skillset' && !clearerUserIds.has(String(vote.userId))) {
          continue;
        }
        voteCount += 1;
        if (vote.direction < 0) downWeight += vote.weight;
        else upWeight += vote.weight;
      }
      const totalWeight = upWeight + downWeight;
      const userVote = userVoteByTag.get(tag.id) ?? null;
      const blockReason = voteBlockReason({
        user,
        isBanned,
        chartCleared,
        levelDeleted: Boolean(level?.isDeleted),
        bandOk: true,
        topPlayOk: settings.requireTopPlay ? topPlayOk : true,
        scoringMode: settings.scoringMode,
        isClearer,
      });

      return {
        ...serializeLevelTag(tag),
        description: tag.description ?? null,
        scoringMode: settings.scoringMode,
        requireTopPlay: settings.requireTopPlay,
        score: wilsonLowerBound(upWeight, totalWeight, settings.wilsonZ),
        assigned: assignment != null,
        pinned: Boolean(assignment?.pinned),
        voted: userVote != null,
        voteDirection: userVote?.direction ?? null,
        weight: userVote?.weight ?? null,
        voteCount,
        upWeight,
        downWeight,
        canVote: blockReason == null,
        voteBlockReason: blockReason,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row != null);

  return { tags, uniqueClears, chartCleared, viewerCleared: isClearer };
}

router.get(
  '/:id([0-9]{1,20})/community-tags',
  Auth.addUserToRequest(),
  ApiDoc({
    operationId: 'getLevelCommunityTags',
    summary: 'List community tag votes for a level',
    description: 'Returns community catalog tags allowed for this level, with scores and the current user vote.',
    tags: ['Database', 'Levels'],
    security: ['bearerAuth'],
    params: { id: idParamSpec },
    responses: { 200: { description: 'Community tags' }, ...standardErrorResponses500 },
  }),
  async (req: Request, res: Response) => {
    try {
      const levelId = parseInt(req.params.id, 10);
      const level = await Level.findByPk(levelId, { attributes: ['id', 'isDeleted'] });
      if (!level) {
        return res.status(404).json({ error: 'Level not found' });
      }
      if (level.isDeleted && (!req.user || !hasFlag(req.user, permissionFlags.SUPER_ADMIN))) {
        return res.status(403).json({ error: 'Cannot vote on deleted level' });
      }
      const payload = await loadCommunityTagVoteState(levelId, req.user);
      return res.json(payload);
    } catch (error) {
      logger.error('Error fetching community tags:', error);
      return res.status(500).json({ error: 'Failed to fetch community tags' });
    }
  },
);

router.put(
  '/:id([0-9]{1,20})/community-tags/:tagId([0-9]{1,20})',
  Auth.verified(),
  communityTagVoteLimiter.middleware,
  ApiDoc({
    operationId: 'putLevelCommunityTagVote',
    summary: 'Upvote, downvote, or unvote a community tag on a level',
    description: 'action: "upvote" | "downvote" | "unvote" ("vote" is an upvote alias). Verified email required.',
    tags: ['Database', 'Levels'],
    security: ['bearerAuth'],
    params: { id: idParamSpec, tagId: { schema: { type: 'string' } } },
    requestBody: {
      description: 'action: upvote | downvote | unvote | vote',
      schema: {
        type: 'object',
        properties: { action: { type: 'string', enum: ['upvote', 'downvote', 'unvote', 'vote'] } },
        required: ['action'],
      },
      required: true,
    },
    responses: {
      200: { description: 'Vote updated' },
      400: { schema: errorResponseSchema },
      401: { schema: errorResponseSchema },
      403: { schema: errorResponseSchema },
      ...standardErrorResponses404500,
    },
  }),
  async (req: Request, res: Response) => {
    let transaction: Awaited<ReturnType<typeof sequelize.transaction>> | undefined;
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (hasFlag(req.user, permissionFlags.TAG_VOTE_BANNED) || req.user.isTagVoteBanned) {
      return res.status(403).json({
        error: 'You are not allowed to vote on community tags',
        reason: 'banned',
      });
    }

    try {
      const levelId = parseInt(req.params.id, 10);
      const tagId = parseInt(req.params.tagId, 10);
      const action = normalizeVoteAction((req.body as { action?: string }).action);
      if (!action) {
        return res.status(400).json({ error: 'Invalid action. Must be "upvote", "downvote", or "unvote"' });
      }

      transaction = await sequelize.transaction();
      const level = await loadLevelWithDifficulty(levelId, transaction);
      if (!level) {
        await safeTransactionRollback(transaction);
        return res.status(404).json({ error: 'Level not found' });
      }
      if (level.isDeleted) {
        await safeTransactionRollback(transaction);
        return res.status(403).json({ error: 'Cannot vote on deleted level', reason: 'deleted' });
      }

      const uniqueClears = await countUniqueClears(levelId, transaction);
      if (uniqueClears < 1) {
        await safeTransactionRollback(transaction);
        return res.status(403).json({
          error: 'Community tags only work on cleared charts',
          reason: 'uncleared',
        });
      }

      const tag = await LevelTag.findByPk(tagId, {
        include: [TAG_GROUP_INCLUDE],
        transaction,
      });
      if (!tag || !tag.isCommunity) {
        await safeTransactionRollback(transaction);
        return res.status(400).json({ error: 'Tag is not a community tag' });
      }

      const envKnobs = getCommunityTagConfig();
      const group = (tag as LevelTag & { tagGroup?: LevelTagGroup | null }).tagGroup ?? null;
      const settings = resolveCommunityTagSettings(tag, group, envKnobs);
      if (!tagAllowedForDifficulty(settings.allowedBands, level.difficulty)) {
        await safeTransactionRollback(transaction);
        return res.status(400).json({
          error: 'This tag is not available for this difficulty',
          reason: 'band',
        });
      }

      const isClearer = await userHasClearerPass(req.user.playerId, levelId, transaction);
      if (settings.requireTopPlay && !isClearer) {
        const [pguDifficulties, liveTopDiff] = await Promise.all([
          loadPguDifficulties(),
          loadPlayerTopPguDifficulty(req.user.playerId, transaction),
        ]);
        if (!isTopPlayRequirementSatisfied({
          levelDiff: level.difficulty,
          topDiff: liveTopDiff,
          pguDifficulties,
          hasClearOfThisLevel: false,
        })) {
          await safeTransactionRollback(transaction);
          return res.status(403).json({
            error: 'Your top play is not high enough to vote on this chart',
            reason: 'topPlay',
          });
        }
      }
      if (settings.scoringMode === 'skillset' && !isClearer) {
        await safeTransactionRollback(transaction);
        return res.status(403).json({
          error: 'You must clear this chart to vote on this tag',
          reason: 'mustClear',
        });
      }

      const existing = await LevelTagVote.findOne({
        where: { levelId, tagId, userId: req.user.id },
        transaction,
      });

      if (action === 'unvote') {
        if (!existing) {
          await safeTransactionRollback(transaction);
          return res.status(400).json({ error: 'You have not voted for this tag' });
        }
        await existing.destroy({ transaction });
      } else {
        const direction = action === 'downvote' ? -1 : 1;
        const weight = voteWeightForClearer(
          settings.scoringMode === 'skillset' ? true : isClearer,
          envKnobs,
        );
        if (existing) {
          await existing.update({ direction, weight }, { transaction });
        } else {
          await LevelTagVote.create(
            {
              levelId,
              tagId,
              userId: req.user.id,
              weight,
              direction,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
            { transaction },
          );
        }
      }

      await rematerializeCommunityTagsForLevel(levelId, [tagId], transaction);
      await transaction.commit();
      transaction = undefined;

      try {
        await ElasticsearchService.getInstance().reindexLevels([levelId]);
        await CacheInvalidation.invalidateTags([`level:${levelId}`, 'levels:all']);
        await invalidatePackLevelsCachesForLevelIds([levelId]);
      } catch (reindexError) {
        logger.warn('Failed to reindex after community tag vote', reindexError);
      }

      const payload = await loadCommunityTagVoteState(levelId, req.user);
      return res.json({ success: true, action, ...payload });
    } catch (error) {
      await safeTransactionRollback(transaction);
      logger.error('Error toggling community tag vote:', error);
      return res.status(500).json({ error: 'Failed to toggle community tag vote' });
    }
  },
);

export default router;
