import { Includeable, Order, Transaction } from 'sequelize';
import LevelTag from '@/models/levels/LevelTag.js';
import LevelTagGroup from '@/models/levels/LevelTagGroup.js';
import LevelTagAssignment from '@/models/levels/LevelTagAssignment.js';
import { getCommunityTagConfig } from '@/config/app.config.js';
import { resolveCommunityTagSettings } from '@/misc/utils/data/communityTagEligibility.js';

export const TAG_GROUP_INCLUDE: Includeable = {
  model: LevelTagGroup,
  as: 'tagGroup',
  required: false,
  attributes: [
    'id',
    'name',
    'sortOrder',
    'wilsonZ',
    'scoreOn',
    'scoreOff',
    'scoringMode',
    'allowedBands',
    'requireTopPlay',
  ],
};

export const TAG_LIST_ORDER: Order = [
  [{ model: LevelTagGroup, as: 'tagGroup' }, 'sortOrder', 'ASC'],
  ['sortOrder', 'ASC'],
  ['name', 'ASC'],
];

export function serializeLevelTag(tag: LevelTag): Record<string, unknown> {
  const plain = (
    typeof (tag as unknown as { toJSON?: () => Record<string, unknown> }).toJSON === 'function'
      ? (tag as unknown as { toJSON: () => Record<string, unknown> }).toJSON()
      : { ...(tag as unknown as Record<string, unknown>) }
  ) as Record<string, unknown> & { tagGroup?: { name?: string; sortOrder?: number } | null };

  const groupModel = (tag as LevelTag & { tagGroup?: LevelTagGroup | null }).tagGroup ?? null;
  const nested = groupModel ?? plain.tagGroup ?? null;
  const { tagGroup: _nested, ...rest } = plain;
  const settings = resolveCommunityTagSettings(tag, groupModel, getCommunityTagConfig());

  return {
    ...rest,
    sortOrder: tag.sortOrder,
    groupId: (rest.groupId as number | null | undefined) ?? null,
    group: nested?.name ?? null,
    groupSortOrder: nested?.sortOrder ?? null,
    description: (rest.description as string | null | undefined) ?? tag.description ?? null,
    settings,
  };
}

export function serializeLevelTags(tags: LevelTag[]): Record<string, unknown>[] {
  return tags.map(serializeLevelTag);
}

export function serializeAssignedLevelTag(
  tag: LevelTag,
  assignment?: { pinned?: boolean | null; score?: number | null } | null,
): Record<string, unknown> {
  return {
    ...serializeLevelTag(tag),
    pinned: Boolean(assignment?.pinned),
    score: assignment?.score ?? null,
  };
}

export function compareSerializedTagOrder(
  a: { groupSortOrder?: number | null; group?: string | null; sortOrder?: number | null; name?: string | null; id?: number },
  b: { groupSortOrder?: number | null; group?: string | null; sortOrder?: number | null; name?: string | null; id?: number },
): number {
  const groupedA = a.group && String(a.group).trim() !== '';
  const groupedB = b.group && String(b.group).trim() !== '';
  const groupA = groupedA ? (a.groupSortOrder ?? 0) : Number.MAX_SAFE_INTEGER;
  const groupB = groupedB ? (b.groupSortOrder ?? 0) : Number.MAX_SAFE_INTEGER;
  if (groupA !== groupB) return groupA - groupB;
  const sortA = a.sortOrder ?? 0;
  const sortB = b.sortOrder ?? 0;
  if (sortA !== sortB) return sortA - sortB;
  const nameCmp = String(a.name || '').localeCompare(String(b.name || ''));
  if (nameCmp !== 0) return nameCmp;
  return (a.id ?? 0) - (b.id ?? 0);
}

export async function loadSerializedAssignedTags(
  levelId: number,
  transaction?: Transaction,
): Promise<Record<string, unknown>[]> {
  const assignments = await LevelTagAssignment.findAll({
    where: { levelId },
    include: [
      {
        model: LevelTag,
        as: 'tag',
        required: true,
        include: [TAG_GROUP_INCLUDE],
      },
    ],
    transaction,
  });

  return assignments
    .map((assignment) => {
      const tag = (assignment as LevelTagAssignment & { tag?: LevelTag }).tag;
      if (!tag) return null;
      return serializeAssignedLevelTag(tag, assignment);
    })
    .filter((row): row is Record<string, unknown> => row != null)
    .sort(compareSerializedTagOrder);
}

export function tagGroupName(tag: LevelTag | { group?: string | null; tagGroup?: { name?: string } | null }): string {
  const nested = (tag as { tagGroup?: { name?: string } | null }).tagGroup?.name;
  if (nested) return nested;
  const serialized = (tag as { group?: string | null }).group;
  return serialized || '';
}

export async function findOrCreateTagGroupByName(
  rawName: string,
  transaction?: Transaction,
): Promise<LevelTagGroup> {
  const name = rawName.trim();
  const existing = await LevelTagGroup.findOne({ where: { name }, transaction });
  if (existing) return existing;

  const maxSortOrder = (await LevelTagGroup.max('sortOrder', { transaction })) as number | null;
  return LevelTagGroup.create(
    {
      name,
      sortOrder: (maxSortOrder ?? -1) + 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    { transaction },
  );
}

/**
 * Resolve a group reference from request body.
 * - `undefined` means the field was omitted (keep existing on update).
 * - `null` means ungrouped.
 * - number means an existing (or find-or-created) group id.
 */
export async function resolveTagGroupId(
  opts: { group?: unknown; groupId?: unknown },
  transaction?: Transaction,
): Promise<number | null | undefined> {
  const hasGroupId = opts.groupId !== undefined;
  const hasGroup = opts.group !== undefined;

  if (!hasGroupId && !hasGroup) {
    return undefined;
  }

  if (hasGroupId && opts.groupId !== null && opts.groupId !== '') {
    const groupId = typeof opts.groupId === 'number' ? opts.groupId : parseInt(String(opts.groupId), 10);
    if (!Number.isFinite(groupId)) {
      throw new Error('Invalid groupId');
    }
    const group = await LevelTagGroup.findByPk(groupId, { transaction });
    if (!group) {
      throw new Error('Tag group not found');
    }
    return group.id;
  }

  if (opts.group === null || opts.group === '' || opts.group === 'null') {
    return null;
  }

  if (typeof opts.group === 'string') {
    const name = opts.group.trim();
    if (!name) return null;
    const group = await findOrCreateTagGroupByName(name, transaction);
    return group.id;
  }

  return null;
}

export async function loadSerializedTag(
  tagId: number,
  transaction?: Transaction,
): Promise<Record<string, unknown> | null> {
  const tag = await LevelTag.findByPk(tagId, {
    include: [TAG_GROUP_INCLUDE],
    transaction,
  });
  return tag ? serializeLevelTag(tag) : null;
}
