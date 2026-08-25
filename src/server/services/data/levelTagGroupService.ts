import { Includeable, Order, Transaction } from 'sequelize';
import LevelTag from '@/models/levels/LevelTag.js';
import LevelTagGroup from '@/models/levels/LevelTagGroup.js';

export const TAG_GROUP_INCLUDE: Includeable = {
  model: LevelTagGroup,
  as: 'tagGroup',
  required: false,
  attributes: ['id', 'name', 'sortOrder'],
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

  const nested =
    (tag as LevelTag & { tagGroup?: LevelTagGroup | null }).tagGroup ?? plain.tagGroup ?? null;
  const { tagGroup: _nested, ...rest } = plain;

  return {
    ...rest,
    groupId: (rest.groupId as number | null | undefined) ?? null,
    group: nested?.name ?? null,
    groupSortOrder: nested?.sortOrder ?? null,
  };
}

export function serializeLevelTags(tags: LevelTag[]): Record<string, unknown>[] {
  return tags.map(serializeLevelTag);
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
