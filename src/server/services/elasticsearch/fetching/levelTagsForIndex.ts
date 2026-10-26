import { Op } from 'sequelize';
import LevelTag from '@/models/levels/LevelTag.js';
import LevelTagGroup from '@/models/levels/LevelTagGroup.js';
import LevelTagAssignment from '@/models/levels/LevelTagAssignment.js';
import { getCommunityTagConfig, type CommunityTagConfig } from '@/config/app.config.js';
import {
  isCommunityTagHiddenForDifficulty,
  type DifficultyLike,
} from '@/misc/utils/data/communityTagEligibility.js';

export type LevelIndexSourceTag = LevelTag & {
  pinned?: boolean;
  score?: number | null;
  tagGroup?: LevelTagGroup | null;
};

export async function fetchLevelTagAssignmentsForIndex(
  levelIds: number[],
): Promise<LevelTagAssignment[]> {
  const ids = [...new Set(levelIds)]
    .map(Number)
    .filter((id) => Number.isFinite(id) && id > 0);
  if (ids.length === 0) return [];

  return LevelTagAssignment.findAll({
    where: { levelId: { [Op.in]: ids } },
    attributes: ['id', 'levelId', 'tagId', 'pinned', 'score'],
    include: [
      {
        model: LevelTag,
        as: 'tag',
        attributes: [
          'id',
          'name',
          'icon',
          'color',
          'groupId',
          'isCommunity',
          'passWarningEnabled',
          'allowedBands',
          'wilsonZ',
          'scoreOn',
          'scoreOff',
          'scoringMode',
          'requireTopPlay',
        ],
        include: [
          {
            model: LevelTagGroup,
            as: 'tagGroup',
            required: false,
            attributes: [
              'id',
              'name',
              'sortOrder',
              'allowedBands',
              'wilsonZ',
              'scoreOn',
              'scoreOff',
              'scoringMode',
              'requireTopPlay',
            ],
          },
        ],
      },
    ],
  });
}

export function groupTagsByLevelId(
  assignments: LevelTagAssignment[],
): Map<number, LevelIndexSourceTag[]> {
  const m = new Map<number, LevelIndexSourceTag[]>();
  for (const a of assignments) {
    const tag = (a as unknown as { tag?: LevelTag }).tag;
    if (!tag) continue;
    const tagged = tag as LevelIndexSourceTag;
    tagged.pinned = Boolean(a.pinned);
    tagged.score = a.score ?? null;
    const arr = m.get(a.levelId) ?? [];
    arr.push(tagged);
    m.set(a.levelId, arr);
  }
  return m;
}

export function filterVisibleLevelTags(
  tags: LevelIndexSourceTag[],
  difficulty: DifficultyLike | null | undefined,
  env: CommunityTagConfig = getCommunityTagConfig(),
): LevelIndexSourceTag[] {
  return tags.filter((tag) => {
    const group = tag.tagGroup ?? null;
    return !isCommunityTagHiddenForDifficulty(tag, group, difficulty, env);
  });
}
