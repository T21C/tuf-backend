import Difficulty from '@/models/levels/Difficulty.js';
import User from '@/models/auth/User.js';
import {
  evaluateRatingFlow,
  resolveCombinedTier,
  type FlowDetail,
  type RatingFlowDecision,
} from '@/misc/utils/data/ratingFlow.js';

export async function attachRatingFlow(rows: Record<string, unknown>[]): Promise<void> {
  if (rows.length === 0) return;

  const difficulties = await Difficulty.findAll({
    attributes: ['id', 'name', 'type', 'sortOrder'],
  });
  const difficultyRows = difficulties.map((row) => ({
    id: row.id,
    name: row.name,
    type: row.type,
    sortOrder: row.sortOrder,
  }));
  const byId = new Map(difficultyRows.map((row) => [row.id, row]));

  const blockerIds = [...new Set(
    rows
      .map((row) => (typeof row.autoRankBlockedBy === 'string' ? row.autoRankBlockedBy : null))
      .filter((id): id is string => Boolean(id)),
  )];
  const blockers = blockerIds.length
    ? await User.findAll({
        where: { id: blockerIds },
        attributes: ['id', 'username', 'nickname', 'avatarUrl'],
      })
    : [];
  const blockersById = new Map(blockers.map((user) => [user.id, user]));
  const autoraterUserId = process.env.AUTORATER_UUID ?? null;

  for (const row of rows) {
    const level = asRecord(row.level);
    const diffId = typeof level?.diffId === 'number' ? level.diffId : Number(level?.diffId ?? 0);
    const diff = Number.isFinite(diffId) ? byId.get(diffId) : undefined;
    const levelTags = level && Array.isArray(level.tags) ? level.tags : [];
    const tags = levelTags
      .map((tag) => asRecord(tag))
      .filter((tag): tag is Record<string, unknown> => tag != null && typeof tag.name === 'string')
      .map((tag) => ({ name: String(tag.name) }));
    const details = flowDetails(row.details);
    const decision = evaluateRatingFlow({
      diffId: Number.isFinite(diffId) ? diffId : 0,
      diffName: diff?.name ?? null,
      clears: Number(level?.clears ?? 0) || 0,
      rerateNum: typeof level?.rerateNum === 'string' ? level.rerateNum : null,
      isDiscordVote: row.isDiscordVote === true,
      combinedTier: resolveCombinedTier(details, autoraterUserId, row.autoraterCombined),
      details,
      autoraterUserId,
      tags,
      manuallyBlocked: typeof row.autoRankBlockedBy === 'string' && row.autoRankBlockedBy.length > 0,
      difficulties: difficultyRows,
    });
    applyDecision(row, decision);
    const blockerId = typeof row.autoRankBlockedBy === 'string' ? row.autoRankBlockedBy : null;
    const blocker = blockerId ? blockersById.get(blockerId) : undefined;
    row.autoRankBlock = blocker
      ? {
          userId: blocker.id,
          username: blocker.username,
          nickname: blocker.nickname ?? null,
          avatarUrl: blocker.avatarUrl ?? null,
          reason: typeof row.autoRankBlockReason === 'string' ? row.autoRankBlockReason : '',
          blockedAt: row.autoRankBlockedAt ?? null,
        }
      : null;
  }
}

function applyDecision(row: Record<string, unknown>, decision: RatingFlowDecision) {
  row.flow = decision.flow;
  row.cardBand = decision.cardBand;
  row.rankState = decision.rankState;
  row.settleActor = decision.settleActor;
  row.suggestedDiffName = decision.suggestedDiffName;
  row.showRankable = decision.showRankable;
  row.showRatingOff = decision.showRatingOff;
  row.autoRankDisabled = decision.autoRankDisabled;
  row.indicators = decision.indicators;
}

function flowDetails(raw: unknown): FlowDetail[] {
  if (!Array.isArray(raw)) return [];
  const details: FlowDetail[] = [];
  for (const item of raw) {
    const row = asRecord(item);
    if (!row || typeof row.rating !== 'string' || typeof row.userId !== 'string') continue;
    details.push({
      id: Number(row.id) || 0,
      userId: row.userId,
      rating: row.rating,
      isCommunityRating: Boolean(row.isCommunityRating),
    });
  }
  return details;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
