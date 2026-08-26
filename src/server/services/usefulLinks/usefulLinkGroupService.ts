import {Includeable, Order, Transaction} from 'sequelize';
import UsefulLink from '@/models/misc/UsefulLink.js';
import UsefulLinkGroup from '@/models/misc/UsefulLinkGroup.js';
import {serializeUsefulLink, compareSerializedLinkOrder, type UsefulLinkJson} from './serializeUsefulLink.js';

export const LINK_GROUP_INCLUDE: Includeable = {
  model: UsefulLinkGroup,
  as: 'linkGroup',
  required: false,
  attributes: ['id', 'name', 'sortOrder'],
};

export const LINK_LIST_ORDER: Order = [
  [{model: UsefulLinkGroup, as: 'linkGroup'}, 'sortOrder', 'ASC'],
  ['sortWeight', 'ASC'],
  ['id', 'ASC'],
];

export function serializeUsefulLinks(links: UsefulLink[]): UsefulLinkJson[] {
  return links.map(serializeUsefulLink);
}

export {compareSerializedLinkOrder};

export async function listSerializedLinks(opts?: {
  publishedOnly?: boolean;
  transaction?: Transaction;
}): Promise<UsefulLinkJson[]> {
  const links = await UsefulLink.findAll({
    where: opts?.publishedOnly ? {isPublished: true} : undefined,
    include: [LINK_GROUP_INCLUDE],
    order: LINK_LIST_ORDER,
    transaction: opts?.transaction,
  });
  return serializeUsefulLinks(links).sort(compareSerializedLinkOrder);
}

export async function loadSerializedLink(
  linkId: number,
  transaction?: Transaction,
): Promise<UsefulLinkJson | null> {
  const link = await UsefulLink.findByPk(linkId, {
    include: [LINK_GROUP_INCLUDE],
    transaction,
  });
  return link ? serializeUsefulLink(link) : null;
}

export function serializeUsefulLinkGroup(group: UsefulLinkGroup) {
  return {
    id: group.id,
    name: group.name,
    sortOrder: group.sortOrder,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
  };
}

export async function findOrCreateLinkGroupByName(
  rawName: string,
  transaction?: Transaction,
): Promise<UsefulLinkGroup> {
  const name = rawName.trim();
  const existing = await UsefulLinkGroup.findOne({where: {name}, transaction});
  if (existing) return existing;

  const maxSortOrder = (await UsefulLinkGroup.max('sortOrder', {transaction})) as number | null;
  return UsefulLinkGroup.create(
    {
      name,
      sortOrder: (maxSortOrder ?? -1) + 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {transaction},
  );
}

/**
 * Resolve a group reference from request body.
 * - `undefined` means the field was omitted (keep existing on update).
 * - `null` means ungrouped.
 * - number means an existing group id.
 * - string name find-or-creates a group (same as tags).
 */
export async function resolveLinkGroupId(
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
    const group = await UsefulLinkGroup.findByPk(groupId, {transaction});
    if (!group) {
      throw new Error('Link group not found');
    }
    return group.id;
  }

  if (opts.group === null || opts.group === '' || opts.group === 'null') {
    return null;
  }

  if (typeof opts.group === 'string') {
    const name = opts.group.trim();
    if (!name) return null;
    const group = await findOrCreateLinkGroupByName(name, transaction);
    return group.id;
  }

  return null;
}
