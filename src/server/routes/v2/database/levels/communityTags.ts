import { Router, Request, Response } from 'express';
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
import LevelTagVote from '@/models/levels/LevelTagVote.js';
import { TAG_GROUP_INCLUDE, TAG_LIST_ORDER, serializeLevelTag } from '@/server/services/data/levelTagGroupService.js';
import {
  rematerializeCommunityTagsForLevel,
  userHasClearerPass,
} from '@/server/services/data/communityTagVoteService.js';
import { getCommunityTagConfig } from '@/config/app.config.js';
import { voteWeightForClearer, wilsonScore } from '@/misc/utils/data/communityTagScoring.js';
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

async function loadCommunityTagVoteState(levelId: number, userId?: string | null) {
  const knobs = getCommunityTagConfig();
  const catalog = await LevelTag.findAll({
    where: { isCommunity: true },
    include: [TAG_GROUP_INCLUDE],
    order: TAG_LIST_ORDER,
  });

  const [assignments, votes] = await Promise.all([
    LevelTagAssignment.findAll({
      where: { levelId },
      attributes: ['tagId', 'pinned', 'score'],
    }),
    LevelTagVote.findAll({
      where: { levelId },
      attributes: ['tagId', 'userId', 'weight'],
    }),
  ]);

  const assignmentByTag = new Map(assignments.map((a) => [a.tagId, a]));
  const weightSumByTag = new Map<number, number>();
  const voteCountByTag = new Map<number, number>();
  const userVoteByTag = new Map<number, number>();

  for (const vote of votes) {
    weightSumByTag.set(vote.tagId, (weightSumByTag.get(vote.tagId) ?? 0) + vote.weight);
    voteCountByTag.set(vote.tagId, (voteCountByTag.get(vote.tagId) ?? 0) + 1);
    if (userId && vote.userId === userId) {
      userVoteByTag.set(vote.tagId, vote.weight);
    }
  }

  return catalog.map((tag) => {
    const assignment = assignmentByTag.get(tag.id);
    const weightSum = weightSumByTag.get(tag.id) ?? 0;
    return {
      ...serializeLevelTag(tag),
      score: wilsonScore(weightSum, knobs.wilsonZ),
      assigned: assignment != null,
      pinned: Boolean(assignment?.pinned),
      voted: userVoteByTag.has(tag.id),
      weight: userVoteByTag.get(tag.id) ?? null,
      voteCount: voteCountByTag.get(tag.id) ?? 0,
      weightSum,
    };
  });
}

async function findVotableLevel(levelId: number) {
  const level = await Level.findByPk(levelId, {
    attributes: ['id', 'isDeleted'],
  });
  return level;
}

router.get(
  '/:id([0-9]{1,20})/community-tags',
  Auth.addUserToRequest(),
  ApiDoc({
    operationId: 'getLevelCommunityTags',
    summary: 'List community tag votes for a level',
    description: 'Returns every community catalog tag with scores and the current user vote.',
    tags: ['Database', 'Levels'],
    security: ['bearerAuth'],
    params: { id: idParamSpec },
    responses: { 200: { description: 'Community tags' }, ...standardErrorResponses500 },
  }),
  async (req: Request, res: Response) => {
    try {
      const levelId = parseInt(req.params.id, 10);
      const level = await findVotableLevel(levelId);
      if (!level) {
        return res.status(404).json({ error: 'Level not found' });
      }
      if (level.isDeleted && (!req.user || !hasFlag(req.user, permissionFlags.SUPER_ADMIN))) {
        return res.status(403).json({ error: 'Cannot vote on deleted level' });
      }
      const tags = await loadCommunityTagVoteState(levelId, req.user?.id ?? null);
      return res.json({ tags });
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
    summary: 'Vote or unvote a community tag on a level',
    description: 'action: "vote" | "unvote". Verified email required.',
    tags: ['Database', 'Levels'],
    security: ['bearerAuth'],
    params: { id: idParamSpec, tagId: { schema: { type: 'string' } } },
    requestBody: {
      description: 'action: "vote" | "unvote"',
      schema: { type: 'object', properties: { action: { type: 'string', enum: ['vote', 'unvote'] } }, required: ['action'] },
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
      return res.status(403).json({ error: 'You are not allowed to vote on community tags' });
    }

    try {
      const levelId = parseInt(req.params.id, 10);
      const tagId = parseInt(req.params.tagId, 10);
      const { action } = req.body as { action?: string };

      if (!action || !['vote', 'unvote'].includes(action)) {
        return res.status(400).json({ error: 'Invalid action. Must be "vote" or "unvote"' });
      }

      transaction = await sequelize.transaction();
      const level = await Level.findByPk(levelId, { transaction, attributes: ['id', 'isDeleted'] });
      if (!level) {
        await safeTransactionRollback(transaction);
        return res.status(404).json({ error: 'Level not found' });
      }
      if (level.isDeleted) {
        await safeTransactionRollback(transaction);
        return res.status(403).json({ error: 'Cannot vote on deleted level' });
      }

      const tag = await LevelTag.findByPk(tagId, { transaction, attributes: ['id', 'isCommunity'] });
      if (!tag || !tag.isCommunity) {
        await safeTransactionRollback(transaction);
        return res.status(400).json({ error: 'Tag is not a community tag' });
      }

      const existing = await LevelTagVote.findOne({
        where: { levelId, tagId, userId: req.user.id },
        transaction,
      });

      if (action === 'vote') {
        const knobs = getCommunityTagConfig();
        const isClearer = await userHasClearerPass(req.user.playerId, levelId, transaction);
        const weight = voteWeightForClearer(isClearer, knobs);
        const [vote, created] = await LevelTagVote.findOrCreate({
          where: { levelId, tagId, userId: req.user.id },
          defaults: {
            levelId,
            tagId,
            userId: req.user.id,
            weight,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          transaction,
        });
        if (!created && vote.weight !== weight) {
          await vote.update({ weight }, { transaction });
        }
      } else {
        if (!existing) {
          await safeTransactionRollback(transaction);
          return res.status(400).json({ error: 'You have not voted for this tag' });
        }
        await existing.destroy({ transaction });
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

      const tags = await loadCommunityTagVoteState(levelId, req.user.id);
      return res.json({ success: true, action, tags });
    } catch (error) {
      await safeTransactionRollback(transaction);
      logger.error('Error toggling community tag vote:', error);
      return res.status(500).json({ error: 'Failed to toggle community tag vote' });
    }
  },
);

export default router;
