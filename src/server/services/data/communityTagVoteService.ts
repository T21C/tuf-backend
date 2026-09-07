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
  communityTagVoteWeight,
  shouldDestroyCommunityAssignment,
  shouldKeepCommunityAssignment,
  wilsonLowerBound,
} from '@/misc/utils/data/communityTagScoring.js';
import {
  isTopPlayRequirementSatisfied,
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

function asUserId(id: unknown): string {
  return String(id ?? '').toLowerCase();
}

function asTagId(id: unknown): number {
  return Number(id);
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
  return new Set(rows.map((row) => asUserId(row.userId)));
}

export async function uniqueClearerPlayerIds(
  levelId: number,
  transaction?: Transaction,
): Promise<Set<number>> {
  const rows = await sequelize.query<{ playerId: number | string }>(
    `SELECT DISTINCT p.playerId AS playerId
     FROM passes AS p
     INNER JOIN players AS pl ON p.playerId = pl.id AND pl.isBanned = 0
     WHERE p.levelId = :levelId AND p.isDeleted = 0 AND p.isHidden = 0`,
    { replacements: { levelId }, type: QueryTypes.SELECT, transaction },
  );
  const ids = new Set<number>();
  for (const row of rows) {
    const id = Number(row.playerId);
    if (Number.isFinite(id)) ids.add(id);
  }
  return ids;
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
    const tagId = asTagId(vote.tagId);
    if (!Number.isFinite(tagId)) continue;
    const list = votesByTag.get(tagId) ?? [];
    list.push(vote);
    votesByTag.set(tagId, list);
  }
  const assignmentByTag = new Map<number, LevelTagAssignment>();
  for (const assignment of assignments) {
    const tagId = asTagId(assignment.tagId);
    if (!Number.isFinite(tagId)) continue;
    assignmentByTag.set(tagId, assignment);
  }

  for (const tag of communityTags) {
    const group = (tag as LevelTag & { tagGroup?: LevelTagGroup | null }).tagGroup ?? null;
    const settings = resolveCommunityTagSettings(tag, group, envKnobs);
    const assignment = assignmentByTag.get(asTagId(tag.id)) ?? null;
    const pinned = Boolean(assignment?.pinned);
    const assigned = assignment != null;
    const bandOk = tagAllowedForDifficulty(settings.allowedBands, difficulty);
    const chartCleared = uniqueClears > 0;

    let upWeight = 0;
    let downWeight = 0;
    if (chartCleared && bandOk) {
      const tagVotes = votesByTag.get(asTagId(tag.id)) ?? [];
      for (const vote of tagVotes) {
        if (!(vote.weight > 0)) continue;
        if (settings.scoringMode === 'skillset' && !clearerUserIds.has(asUserId(vote.userId))) {
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

async function loadPguDifficulties(transaction?: Transaction) {
  return Difficulty.findAll({
    where: { type: 'PGU' },
    attributes: ['id', 'name', 'type', 'sortOrder'],
    order: [['sortOrder', 'ASC']],
    transaction,
  });
}

/**
 * Per-tag 0 / default / clearer weights for every vote on a level, then rematerialize.
 * Used after pass create/delete/hide so first-clears also promote other voters' inert Wilson votes.
 */
export async function syncVoteWeightsForLevel(
  levelId: number,
  transaction?: Transaction,
): Promise<void> {
  const votes = await LevelTagVote.findAll({
    where: { levelId },
    attributes: ['id', 'userId', 'tagId', 'weight'],
    transaction,
  });
  if (votes.length === 0) {
    await rematerializeCommunityTagsForLevel(levelId, undefined, transaction);
    return;
  }

  const envKnobs = getCommunityTagConfig();
  const tagIds = [...new Set(votes.map((vote) => vote.tagId))];
  const userIds = [...new Set(votes.map((vote) => vote.userId))];

  const [communityTags, uniqueClears, difficulty, clearerPlayerIds, users] = await Promise.all([
    LevelTag.findAll({
      where: { id: { [Op.in]: tagIds } },
      include: [TAG_GROUP_INCLUDE],
      transaction,
    }),
    countUniqueClears(levelId, transaction),
    loadLevelDifficulty(levelId, transaction),
    uniqueClearerPlayerIds(levelId, transaction),
    User.findAll({
      where: { id: { [Op.in]: userIds } },
      attributes: ['id', 'playerId'],
      transaction,
    }),
  ]);

  const tagById = new Map(communityTags.map((tag) => [asTagId(tag.id), tag]));
  const userById = new Map(users.map((user) => [asUserId(user.id), user]));
  const chartCleared = uniqueClears > 0;

  const needsTopPlayLookup = communityTags.some((tag) => {
    const group = (tag as LevelTag & { tagGroup?: LevelTagGroup | null }).tagGroup ?? null;
    return resolveCommunityTagSettings(tag, group, envKnobs).requireTopPlay;
  });

  const topPlayOkByUserId = new Map<string, boolean>();
  if (needsTopPlayLookup) {
    const pguDifficulties = await loadPguDifficulties(transaction);
    const playerIds = [
      ...new Set(
        users
          .map((user) => user.playerId)
          .filter((playerId): playerId is number => playerId != null && Number.isFinite(playerId)),
      ),
    ];
    const topDiffByPlayerId = new Map<number, DifficultyLike | null>();
    await Promise.all(
      playerIds.map(async (playerId) => {
        topDiffByPlayerId.set(playerId, await loadPlayerTopPguDifficulty(playerId, transaction));
      }),
    );
    for (const user of users) {
      const userId = asUserId(user.id);
      const isClearer = user.playerId != null && clearerPlayerIds.has(Number(user.playerId));
      topPlayOkByUserId.set(
        userId,
        isTopPlayRequirementSatisfied({
          levelDiff: difficulty,
          topDiff: user.playerId != null ? (topDiffByPlayerId.get(user.playerId) ?? null) : null,
          pguDifficulties,
          hasClearOfThisLevel: isClearer,
        }),
      );
    }
  }

  for (const vote of votes) {
    const tag = tagById.get(asTagId(vote.tagId));
    if (!tag || !tag.isCommunity) continue;
    const group = (tag as LevelTag & { tagGroup?: LevelTagGroup | null }).tagGroup ?? null;
    const settings = resolveCommunityTagSettings(tag, group, envKnobs);
    const userId = asUserId(vote.userId);
    const user = userById.get(userId);
    const isClearer = user?.playerId != null && clearerPlayerIds.has(Number(user.playerId));
    const topPlayOk = settings.requireTopPlay ? (topPlayOkByUserId.get(userId) ?? false) : true;
    const weight = communityTagVoteWeight(
      {
        chartCleared,
        scoringMode: settings.scoringMode,
        isClearer,
        topPlayOk,
      },
      envKnobs,
    );
    if (Number(vote.weight) !== weight) {
      await vote.update({ weight }, { transaction });
    }
  }

  await rematerializeCommunityTagsForLevel(levelId, undefined, transaction);
}

export async function syncClearerVoteWeightsForPlayerLevel(
  _playerId: number,
  levelId: number,
  transaction?: Transaction,
): Promise<void> {
  await syncVoteWeightsForLevel(levelId, transaction);
}

export async function syncClearerVoteWeightsForPairs(
  pairs: Array<{ playerId: number; levelId: number }>,
): Promise<void> {
  const levelIds = new Set<number>();
  for (const pair of pairs) {
    if (Number.isFinite(pair.levelId)) levelIds.add(pair.levelId);
  }
  for (const levelId of levelIds) {
    try {
      await syncVoteWeightsForLevel(levelId);
    } catch (error) {
      logger.error('Failed to sync community tag vote weights', {
        levelId,
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
