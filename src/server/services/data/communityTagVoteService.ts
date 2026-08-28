import { Op, QueryTypes, Transaction } from 'sequelize';
import sequelize from '@/config/db.js';
import { getCommunityTagConfig } from '@/config/app.config.js';
import Level from '@/models/levels/Level.js';
import LevelTag from '@/models/levels/LevelTag.js';
import LevelTagAssignment from '@/models/levels/LevelTagAssignment.js';
import LevelTagGroup from '@/models/levels/LevelTagGroup.js';
import LevelTagVote from '@/models/levels/LevelTagVote.js';
import Pass from '@/models/passes/Pass.js';
import Player from '@/models/players/Player.js';
import User from '@/models/auth/User.js';
import Difficulty from '@/models/levels/Difficulty.js';
import {
  shouldDestroyCommunityAssignment,
  shouldKeepCommunityAssignment,
  voteWeightForClearer,
  wilsonLowerBound,
} from '@/misc/utils/data/communityTagScoring.js';
import {
  resolveCommunityTagSettings,
  tagAllowedForDifficulty,
  type DifficultyLike,
} from '@/misc/utils/data/communityTagEligibility.js';
import { TAG_GROUP_INCLUDE } from '@/server/services/data/levelTagGroupService.js';
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
      isHidden: false,
    },
    include: [
      {
        model: Player,
        as: 'player',
        attributes: ['id'],
        required: true,
        where: { isBanned: false },
      },
    ],
    attributes: ['id'],
    transaction,
  });
  return !!pass;
}

function coerceDifficultyLike(row: {
  id?: number | string | null;
  name?: string | null;
  type?: string | null;
  sortOrder?: number | string | null;
} | undefined): DifficultyLike | null {
  if (!row) return null;
  const id = Number(row.id);
  const sortOrder = Number(row.sortOrder);
  if (!Number.isFinite(id) || !Number.isFinite(sortOrder)) return null;
  return {
    id,
    name: row.name ?? null,
    type: row.type ?? null,
    sortOrder,
  };
}

/**
 * Live PGU top play from passes, not stale MySQL player_stats / /me.
 */
export async function loadPlayerTopPguDifficulty(
  playerId: number | null | undefined,
  transaction?: Transaction,
): Promise<DifficultyLike | null> {
  if (playerId == null) return null;
  const rows = await sequelize.query<{
    id: number | string;
    name: string | null;
    type: string | null;
    sortOrder: number | string | null;
  }>(
    `SELECT ps.diffId AS id, ps.name, ps.type, ps.sortOrder
     FROM player_pass_summary AS ps
     INNER JOIN players AS pl ON pl.id = ps.playerId AND pl.isBanned = 0
     WHERE ps.playerId = :playerId AND ps.type = 'PGU'
     ORDER BY ps.sortOrder DESC, ps.diffId DESC
     LIMIT 1`,
    { replacements: { playerId }, type: QueryTypes.SELECT, transaction },
  );
  return coerceDifficultyLike(rows[0]);
}

export async function countUniqueClears(
  levelId: number,
  transaction?: Transaction,
): Promise<number> {
  const rows = await sequelize.query<{ uniqueCnt: number | string }>(
    `SELECT COUNT(DISTINCT p.playerId) AS uniqueCnt
     FROM passes AS p
     INNER JOIN players AS pl ON p.playerId = pl.id AND pl.isBanned = 0
     WHERE p.levelId = :levelId AND p.isDeleted = 0 AND p.isHidden = 0`,
    { replacements: { levelId }, type: QueryTypes.SELECT, transaction },
  );
  return Number(rows[0]?.uniqueCnt ?? 0);
}

export async function uniqueClearerUserIds(
  levelId: number,
  transaction?: Transaction,
): Promise<Set<string>> {
  const rows = await sequelize.query<{ userId: string }>(
    `SELECT u.id AS userId
     FROM passes AS p
     INNER JOIN players AS pl ON p.playerId = pl.id AND pl.isBanned = 0
     INNER JOIN users AS u ON u.playerId = p.playerId
     WHERE p.levelId = :levelId AND p.isDeleted = 0 AND p.isHidden = 0`,
    { replacements: { levelId }, type: QueryTypes.SELECT, transaction },
  );
  return new Set(rows.map((row) => row.userId));
}

async function loadLevelDifficulty(
  levelId: number,
  transaction?: Transaction,
): Promise<DifficultyLike | null> {
  const level = await Level.findByPk(levelId, {
    attributes: ['id', 'diffId'],
    include: [
      {
        model: Difficulty,
        as: 'difficulty',
        attributes: ['id', 'name', 'type', 'sortOrder'],
        required: false,
      },
    ],
    transaction,
  });
  const difficulty = (level as Level & { difficulty?: Difficulty | null } | null)?.difficulty ?? null;
  if (!difficulty) return null;
  return {
    id: difficulty.id,
    name: difficulty.name,
    type: difficulty.type,
    sortOrder: difficulty.sortOrder,
  };
}

export type RematerializeCommunityTagOptions = {
  preserveAssignments?: boolean;
};

export async function rematerializeCommunityTagsForLevel(
  levelId: number,
  tagIds?: number[],
  transaction?: Transaction,
  options?: RematerializeCommunityTagOptions,
): Promise<void> {
  const preserveAssignments = Boolean(options?.preserveAssignments);
  const envKnobs = getCommunityTagConfig();
  const where: Record<string, unknown> = { isCommunity: true };
  if (tagIds && tagIds.length > 0) {
    where.id = { [Op.in]: tagIds };
  }

  const communityTags = await LevelTag.findAll({
    where,
    include: [TAG_GROUP_INCLUDE],
    transaction,
  });
  if (communityTags.length === 0) return;

  const ids = communityTags.map((t) => t.id);
  const uniqueClears = await countUniqueClears(levelId, transaction);
  const difficulty = await loadLevelDifficulty(levelId, transaction);
  const clearerUserIds = await uniqueClearerUserIds(levelId, transaction);

  const [votes, assignments] = await Promise.all([
    LevelTagVote.findAll({
      where: { levelId, tagId: { [Op.in]: ids } },
      attributes: ['tagId', 'userId', 'weight', 'direction'],
      transaction,
    }),
    LevelTagAssignment.findAll({
      where: { levelId, tagId: { [Op.in]: ids } },
      transaction,
    }),
  ]);

  const votesByTag = new Map<number, LevelTagVote[]>();
  for (const vote of votes) {
    const list = votesByTag.get(vote.tagId) ?? [];
    list.push(vote);
    votesByTag.set(vote.tagId, list);
  }
  const assignmentByTag = new Map(assignments.map((a) => [a.tagId, a]));

  for (const tag of communityTags) {
    const group = (tag as LevelTag & { tagGroup?: LevelTagGroup | null }).tagGroup ?? null;
    const settings = resolveCommunityTagSettings(tag, group, envKnobs);
    const assignment = assignmentByTag.get(tag.id) ?? null;
    const pinned = Boolean(assignment?.pinned);
    const assigned = assignment != null;
    const bandOk = tagAllowedForDifficulty(settings.allowedBands, difficulty);
    const chartCleared = uniqueClears > 0;

    let upWeight = 0;
    let downWeight = 0;
    if (chartCleared && bandOk) {
      const tagVotes = votesByTag.get(tag.id) ?? [];
      for (const vote of tagVotes) {
        if (settings.scoringMode === 'skillset' && !clearerUserIds.has(vote.userId)) {
          continue;
        }
        if (vote.direction < 0) downWeight += vote.weight;
        else upWeight += vote.weight;
      }
    }
    const totalWeight = upWeight + downWeight;
    const score = wilsonLowerBound(upWeight, totalWeight, settings.wilsonZ);

    if (pinned) {
      if (assignment && assignment.score !== score) {
        await assignment.update({ score }, { transaction });
      }
      continue;
    }

    const destroy = shouldDestroyCommunityAssignment({
      preserveAssignments,
      chartCleared,
      bandOk,
      keep: shouldKeepCommunityAssignment({
        assigned,
        pinned: false,
        score,
        knobs: settings,
      }),
    });

    if (!destroy) {
      if (assignment) {
        if (assignment.score !== score) {
          await assignment.update({ score }, { transaction });
        }
      } else if (chartCleared && bandOk) {
        const keepNew = shouldKeepCommunityAssignment({
          assigned: false,
          pinned: false,
          score,
          knobs: settings,
        });
        if (keepNew) {
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
      }
    } else if (assignment) {
      await assignment.destroy({ transaction });
    }
  }
}

export async function rematerializeCommunityTagsForTagIds(
  tagIds: number[],
  transaction?: Transaction,
  options?: RematerializeCommunityTagOptions,
): Promise<void> {
  const ids = [...new Set(tagIds.filter((id) => Number.isFinite(id)))];
  if (ids.length === 0) return;

  const [voteRows, assignmentRows] = await Promise.all([
    LevelTagVote.findAll({
      where: { tagId: { [Op.in]: ids } },
      attributes: ['levelId'],
      transaction,
    }),
    LevelTagAssignment.findAll({
      where: { tagId: { [Op.in]: ids } },
      attributes: ['levelId'],
      transaction,
    }),
  ]);

  const levelIds = [...new Set([
    ...voteRows.map((row) => row.levelId),
    ...assignmentRows.map((row) => row.levelId),
  ])];

  for (const levelId of levelIds) {
    await rematerializeCommunityTagsForLevel(levelId, ids, transaction, options);
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
  if (!user) {
    await rematerializeCommunityTagsForLevel(levelId, undefined, transaction);
    return;
  }

  const knobs = getCommunityTagConfig();
  const isClearer = await userHasClearerPass(playerId, levelId, transaction);
  const weight = voteWeightForClearer(isClearer, knobs);

  await LevelTagVote.update(
    { weight },
    { where: { userId: user.id, levelId }, transaction },
  );

  await rematerializeCommunityTagsForLevel(levelId, undefined, transaction);
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
