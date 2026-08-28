import {Includeable, Order, Transaction} from 'sequelize';
import UsefulLinkTag from '@/models/misc/UsefulLinkTag.js';
import UsefulLinkTagGroup from '@/models/misc/UsefulLinkTagGroup.js';
import UsefulLinkTagAssignment from '@/models/misc/UsefulLinkTagAssignment.js';

export type UsefulLinkTagJson = {
  id: number;
  name: string;
  color: string;
  groupId: number | null;
  group: string | null;
  groupSortOrder: number | null;
  sortOrder: number;
};

export type UsefulLinkTagGroupJson = {
  id: number;
  name: string;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
};

export const TAG_GROUP_INCLUDE: Includeable = {
  model: UsefulLinkTagGroup,
  as: 'tagGroup',
  required: false,
  attributes: ['id', 'name', 'sortOrder'],
};

export const TAG_LIST_ORDER: Order = [
  [{model: UsefulLinkTagGroup, as: 'tagGroup'}, 'sortOrder', 'ASC'],
  ['sortOrder', 'ASC'],
  ['name', 'ASC'],
];

type TagWithGroup = UsefulLinkTag & {tagGroup?: UsefulLinkTagGroup | null};

export function serializeUsefulLinkTag(tag: UsefulLinkTag): UsefulLinkTagJson {
  const nested = (tag as TagWithGroup).tagGroup ?? null;
  return {
    id: tag.id,
    name: tag.name,
    color: tag.color,
    groupId: tag.groupId ?? null,
    group: nested?.name ?? null,
    groupSortOrder: nested?.sortOrder ?? null,
    sortOrder: tag.sortOrder,
  };
}

export function serializeUsefulLinkTagGroup(group: UsefulLinkTagGroup): UsefulLinkTagGroupJson {
  return {
    id: group.id,
    name: group.name,
    sortOrder: group.sortOrder,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
  };
}

export function compareSerializedTagOrder(
  a: {
    groupSortOrder?: number | null;
    group?: string | null;
    sortOrder?: number | null;
    name?: string | null;
    id?: number;
  },
  b: {
    groupSortOrder?: number | null;
    group?: string | null;
    sortOrder?: number | null;
    name?: string | null;
    id?: number;
  },
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

export async function listSerializedTags(transaction?: Transaction): Promise<UsefulLinkTagJson[]> {
  const tags = await UsefulLinkTag.findAll({
    include: [TAG_GROUP_INCLUDE],
    order: TAG_LIST_ORDER,
    transaction,
  });
  return tags.map(serializeUsefulLinkTag).sort(compareSerializedTagOrder);
}

export async function loadSerializedTag(
  tagId: number,
  transaction?: Transaction,
): Promise<UsefulLinkTagJson | null> {
  const tag = await UsefulLinkTag.findByPk(tagId, {
    include: [TAG_GROUP_INCLUDE],
    transaction,
  });
  return tag ? serializeUsefulLinkTag(tag) : null;
}

export async function findOrCreateTagGroupByName(
  rawName: string,
  transaction?: Transaction,
): Promise<UsefulLinkTagGroup> {
  const name = rawName.trim();
  const existing = await UsefulLinkTagGroup.findOne({where: {name}, transaction});
  if (existing) return existing;

  const maxSortOrder = (await UsefulLinkTagGroup.max('sortOrder', {transaction})) as number | null;
  return UsefulLinkTagGroup.create(
    {
      name,
      sortOrder: (maxSortOrder ?? -1) + 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {transaction},
  );
}

export async function resolveTagGroupId(
  opts: {group?: unknown; groupId?: unknown},
  transaction?: Transaction,
): Promise<number | null | undefined> {
  const hasGroupId = opts.groupId !== undefined;
  const hasGroup = opts.group !== undefined;

  if (!hasGroupId && !hasGroup) {
    return undefined;
  }

  if (hasGroupId && opts.groupId !== null && opts.groupId !== '') {
    const groupId =
      typeof opts.groupId === 'number' ? opts.groupId : parseInt(String(opts.groupId), 10);
    if (!Number.isFinite(groupId)) {
      throw new Error('Invalid groupId');
    }
    const group = await UsefulLinkTagGroup.findByPk(groupId, {transaction});
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

export async function replaceLinkTags(
  linkId: number,
  tagIds: number[],
  transaction?: Transaction,
): Promise<void> {
  const unique = [...new Set(tagIds.filter((id) => Number.isInteger(id) && id > 0))];
  if (unique.length) {
    const found = await UsefulLinkTag.findAll({
      where: {id: unique},
      attributes: ['id'],
      transaction,
    });
    if (found.length !== unique.length) {
      throw new Error('Tag not found');
    }
  }

  await UsefulLinkTagAssignment.destroy({where: {linkId}, transaction});
  if (!unique.length) return;
  await UsefulLinkTagAssignment.bulkCreate(
    unique.map((tagId) => ({
      linkId,
      tagId,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
    {transaction},
  );
}

export const LINK_TAGS_INCLUDE: Includeable = {
  model: UsefulLinkTag,
  as: 'tags',
  required: false,
  include: [TAG_GROUP_INCLUDE],
  through: {attributes: []},
};
