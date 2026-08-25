import { Op, Transaction } from 'sequelize';
import { getCommunityTagConfig } from '@/config/app.config.js';
import LevelTag from '@/models/levels/LevelTag.js';
import LevelTagAssignment from '@/models/levels/LevelTagAssignment.js';
import LevelTagVote from '@/models/levels/LevelTagVote.js';
import Pass from '@/models/passes/Pass.js';
import User from '@/models/auth/User.js';
import {
  shouldKeepCommunityAssignment,
  voteWeightForClearer,
  wilsonScore,
} from '@/misc/utils/data/communityTagScoring.js';
import { logger } from '@/server/services/core/LoggerService.js';

export async function userHasClearerPass(
  playerId: number | null | undefined,
  levelId: number,
  transaction?: Transaction,
): Promise<boolean> {
  if (playerId == null) return false;
  const pass = await Pass.findOne({
    where: {
      playerId,
      levelId,
      isDeleted: false,
    },
    attributes: ['id'],
    transaction,
  });
  return !!pass;
}

export async function rematerializeCommunityTagsForLevel(
  levelId: number,
  tagIds?: number[],
  transaction?: Transaction,
): Promise<void> {
  const knobs = getCommunityTagConfig();
  const where: Record<string, unknown> = { isCommunity: true };
  if (tagIds && tagIds.length > 0) {
    where.id = { [Op.in]: tagIds };
  }

  const communityTags = await LevelTag.findAll({
    where,
    attributes: ['id'],
    transaction,
  });
  if (communityTags.length === 0) return;

  const ids = communityTags.map((t) => t.id);

  const [votes, assignments] = await Promise.all([
    LevelTagVote.findAll({
      where: { levelId, tagId: { [Op.in]: ids } },
      attributes: ['tagId', 'weight'],
      transaction,
    }),
    LevelTagAssignment.findAll({
      where: { levelId, tagId: { [Op.in]: ids } },
      transaction,
    }),
  ]);

  const weightByTag = new Map<number, number>();
  for (const vote of votes) {
    weightByTag.set(vote.tagId, (weightByTag.get(vote.tagId) ?? 0) + vote.weight);
  }
  const assignmentByTag = new Map(assignments.map((a) => [a.tagId, a]));

  for (const tag of communityTags) {
    const assignment = assignmentByTag.get(tag.id) ?? null;
    const weightSum = weightByTag.get(tag.id) ?? 0;
    const score = wilsonScore(weightSum, knobs.wilsonZ);
    const pinned = Boolean(assignment?.pinned);
    const assigned = assignment != null;
    const keep = shouldKeepCommunityAssignment({
      assigned,
      pinned,
      score,
      knobs,
    });

    if (keep) {
      if (assignment) {
        const nextScore = weightSum > 0 || pinned ? score : assignment.score;
        if (assignment.score !== nextScore) {
          await assignment.update({ score: nextScore }, { transaction });
        }
      } else {
        await LevelTagAssignment.create(
          {
            levelId,
            tagId: tag.id,
            pinned: false,
            score,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          { transaction },
        );
      }
    } else if (assignment && !assignment.pinned) {
      await assignment.destroy({ transaction });
    }
  }
}

export async function pinCommunityAssignmentsForTag(
  tagId: number,
  transaction?: Transaction,
): Promise<void> {
  await LevelTagAssignment.update(
    { pinned: true },
    { where: { tagId }, transaction },
  );
}

export async function syncClearerVoteWeightsForPlayerLevel(
  playerId: number,
  levelId: number,
  transaction?: Transaction,
): Promise<void> {
  const user = await User.findOne({
    where: { playerId },
    attributes: ['id', 'playerId'],
    transaction,
  });
  if (!user) return;

  const knobs = getCommunityTagConfig();
  const isClearer = await userHasClearerPass(playerId, levelId, transaction);
  const weight = voteWeightForClearer(isClearer, knobs);

  const [affected] = await LevelTagVote.update(
    { weight },
    { where: { userId: user.id, levelId }, transaction },
  );

  if (affected > 0) {
    await rematerializeCommunityTagsForLevel(levelId, undefined, transaction);
  }
}

export async function syncClearerVoteWeightsForPairs(
  pairs: Array<{ playerId: number; levelId: number }>,
): Promise<void> {
  const seen = new Set<string>();
  for (const pair of pairs) {
    if (!Number.isFinite(pair.playerId) || !Number.isFinite(pair.levelId)) continue;
    const key = `${pair.playerId}:${pair.levelId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      await syncClearerVoteWeightsForPlayerLevel(pair.playerId, pair.levelId);
    } catch (error) {
      logger.error('Failed to sync community tag vote weights', {
        playerId: pair.playerId,
        levelId: pair.levelId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export async function applyStaffTagSelection(
  levelId: number,
  tagIds: number[],
  transaction: Transaction,
): Promise<void> {
  const uniqueIds = [...new Set(tagIds.filter((id) => Number.isFinite(id)))];
  const postedTags = uniqueIds.length
    ? await LevelTag.findAll({
        where: { id: { [Op.in]: uniqueIds } },
        transaction,
      })
    : [];

  if (postedTags.length !== uniqueIds.length) {
    throw new Error('INVALID_TAG_IDS');
  }

  const postedCommunityIds = new Set(
    postedTags.filter((t) => t.isCommunity).map((t) => t.id),
  );
  const postedStaffIds = new Set(
    postedTags.filter((t) => !t.isCommunity).map((t) => t.id),
  );

  const existing = await LevelTagAssignment.findAll({
    where: { levelId },
    include: [{ model: LevelTag, as: 'tag', attributes: ['id', 'isCommunity'] }],
    transaction,
  });

  const existingByTag = new Map(existing.map((a) => [a.tagId, a]));

  for (const assignment of existing) {
    const tag = (assignment as LevelTagAssignment & { tag?: LevelTag }).tag;
    const isCommunity = Boolean(tag?.isCommunity);
    if (isCommunity) continue;
    if (!postedStaffIds.has(assignment.tagId)) {
      await assignment.destroy({ transaction });
    }
  }

  const now = new Date();
  for (const tagId of postedStaffIds) {
    const current = existingByTag.get(tagId);
    if (!current) {
      await LevelTagAssignment.create(
        {
          levelId,
          tagId,
          pinned: false,
          score: null,
          createdAt: now,
          updatedAt: now,
        },
        { transaction },
      );
    }
  }

  const communityTags = await LevelTag.findAll({
    where: { isCommunity: true },
    attributes: ['id'],
    transaction,
  });
  const allCommunityIds = communityTags.map((t) => t.id);

  for (const tagId of allCommunityIds) {
    const current = existingByTag.get(tagId);
    const shouldPin = postedCommunityIds.has(tagId);
    if (shouldPin) {
      if (current) {
        if (!current.pinned) {
          await current.update({ pinned: true }, { transaction });
        }
      } else {
        await LevelTagAssignment.create(
          {
            levelId,
            tagId,
            pinned: true,
            score: null,
            createdAt: now,
            updatedAt: now,
          },
          { transaction },
        );
      }
    } else if (current?.pinned) {
      await current.update({ pinned: false }, { transaction });
    }
  }

  await rematerializeCommunityTagsForLevel(levelId, allCommunityIds, transaction);
}
