import {Includeable, Op, Order, Transaction} from 'sequelize';
import UsefulLink from '@/models/misc/UsefulLink.js';
import UsefulLinkLocale from '@/models/misc/UsefulLinkLocale.js';
import UsefulLinkGroup from '@/models/misc/UsefulLinkGroup.js';
import UsefulLinkGroupAssignment from '@/models/misc/UsefulLinkGroupAssignment.js';
import {
  serializeUsefulLink,
  compareSerializedLinkOrder,
  type UsefulLinkJson,
} from './serializeUsefulLink.js';
import {DEFAULT_SITE_LANGUAGE} from '@/config/siteLanguages.js';

export {serializeUsefulLink, compareSerializedLinkOrder, type UsefulLinkJson};

export type UsefulLinkGroupJson = {
  id: number;
  name: string;
  sortOrder: number;
  linkIds: number[];
};

export type UsefulLinksCatalogJson = {
  groups: UsefulLinkGroupJson[];
  links: UsefulLinkJson[];
};

export const LINK_LOCALES_INCLUDE: Includeable = {
  model: UsefulLinkLocale,
  as: 'locales',
  required: false,
};

export const LINK_LIST_ORDER: Order = [
  ['sortWeight', 'ASC'],
  ['id', 'ASC'],
];

export const GROUP_LIST_ORDER: Order = [
  ['sortOrder', 'ASC'],
  ['id', 'ASC'],
];

export function serializeGroup(
  group: UsefulLinkGroup,
  linkIds: number[] = [],
): UsefulLinkGroupJson {
  return {
    id: group.id,
    name: group.name,
    sortOrder: group.sortOrder,
    linkIds,
  };
}

export async function listSerializedGroups(
  transaction?: Transaction,
): Promise<UsefulLinkGroup[]> {
  return UsefulLinkGroup.findAll({
    order: GROUP_LIST_ORDER,
    transaction,
  });
}

export async function loadSerializedLink(
  linkId: number,
  transaction?: Transaction,
): Promise<UsefulLinkJson | null> {
  const link = await UsefulLink.findByPk(linkId, {
    include: [LINK_LOCALES_INCLUDE],
    transaction,
  });
  if (!link) return null;
  const assignments = await UsefulLinkGroupAssignment.findAll({
    where: {linkId},
    attributes: ['groupId'],
    transaction,
  });
  return serializeUsefulLink(
    link,
    assignments.map((row) => row.groupId),
  );
}

export async function listResourcesCatalog(
  transaction?: Transaction,
): Promise<UsefulLinksCatalogJson> {
  const [groups, assignments, links] = await Promise.all([
    listSerializedGroups(transaction),
    UsefulLinkGroupAssignment.findAll({
      order: [
        ['sortOrder', 'ASC'],
        ['id', 'ASC'],
      ],
      transaction,
    }),
    UsefulLink.findAll({
      include: [LINK_LOCALES_INCLUDE],
      order: LINK_LIST_ORDER,
      transaction,
    }),
  ]);

  const linkIdsByGroup = new Map<number, number[]>();
  const groupIdsByLink = new Map<number, number[]>();
  for (const row of assignments) {
    const groupList = linkIdsByGroup.get(row.groupId) ?? [];
    if (!groupList.includes(row.linkId)) groupList.push(row.linkId);
    linkIdsByGroup.set(row.groupId, groupList);
    const linkList = groupIdsByLink.get(row.linkId) ?? [];
    if (!linkList.includes(row.groupId)) linkList.push(row.groupId);
    groupIdsByLink.set(row.linkId, linkList);
  }

  return {
    groups: groups.map((group) => serializeGroup(group, linkIdsByGroup.get(group.id) ?? [])),
    links: links
      .map((link) => serializeUsefulLink(link, groupIdsByLink.get(link.id) ?? []))
      .sort(compareSerializedLinkOrder),
  };
}

export async function upsertEnglishLocale(
  link: {id: number; title: string; url: string; description?: string | null; shorthand?: string | null},
  transaction?: Transaction,
): Promise<void> {
  const existing = await UsefulLinkLocale.findOne({
    where: {linkId: link.id, languageCode: DEFAULT_SITE_LANGUAGE},
    transaction,
  });
  const fields = {
    title: link.title,
    url: link.url,
    description: link.description ?? null,
    shorthand: link.shorthand ?? null,
    updatedAt: new Date(),
  };
  if (existing) {
    await existing.update(fields, {transaction});
    return;
  }
  await UsefulLinkLocale.create(
    {
      linkId: link.id,
      languageCode: DEFAULT_SITE_LANGUAGE,
      ...fields,
      createdAt: new Date(),
    },
    {transaction},
  );
}

export async function firstGroup(transaction?: Transaction): Promise<UsefulLinkGroup | null> {
  return UsefulLinkGroup.findOne({
    order: GROUP_LIST_ORDER,
    transaction,
  });
}

async function maxAssignmentSort(
  groupId: number,
  transaction?: Transaction,
): Promise<number> {
  const max = (await UsefulLinkGroupAssignment.max('sortOrder', {
    where: {groupId},
    transaction,
  })) as number | null;
  return Number(max) || 0;
}

export async function replaceLinkGroups(
  linkId: number,
  groupIds: number[],
  transaction?: Transaction,
): Promise<void> {
  let unique = [...new Set(groupIds.filter((id) => Number.isInteger(id) && id > 0))];
  if (!unique.length) {
    const first = await firstGroup(transaction);
    unique = first ? [first.id] : [];
  }
  if (unique.length) {
    const found = await UsefulLinkGroup.findAll({
      where: {id: unique},
      attributes: ['id'],
      transaction,
    });
    if (found.length !== unique.length) {
      throw new Error('Group not found');
    }
  }

  const existing = await UsefulLinkGroupAssignment.findAll({
    where: {linkId},
    transaction,
  });
  const keep = new Set(unique);
  for (const row of existing) {
    if (!keep.has(row.groupId)) {
      await row.destroy({transaction});
    }
  }
  const have = new Set(existing.map((row) => row.groupId));
  for (const groupId of unique) {
    if (have.has(groupId)) continue;
    const sortOrder = (await maxAssignmentSort(groupId, transaction)) + 1;
    await UsefulLinkGroupAssignment.create(
      {linkId, groupId, sortOrder, createdAt: new Date(), updatedAt: new Date()},
      {transaction},
    );
  }
}

export async function assignUngroupedLinksToGroup(
  groupId: number,
  transaction?: Transaction,
): Promise<void> {
  const assigned = await UsefulLinkGroupAssignment.findAll({
    attributes: ['linkId'],
    transaction,
  });
  const assignedIds = new Set(assigned.map((row) => row.linkId));
  const unassigned = await UsefulLink.findAll({
    attributes: ['id', 'sortWeight'],
    order: LINK_LIST_ORDER,
    transaction,
  });
  let sortOrder = await maxAssignmentSort(groupId, transaction);
  for (const link of unassigned) {
    if (assignedIds.has(link.id)) continue;
    sortOrder += 1;
    await UsefulLinkGroupAssignment.create(
      {
        linkId: link.id,
        groupId,
        sortOrder,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {transaction},
    );
  }
}

export async function ensureLinksHaveAGroup(transaction?: Transaction): Promise<void> {
  const first = await firstGroup(transaction);
  if (!first) return;
  await assignUngroupedLinksToGroup(first.id, transaction);
}

export async function applyGroupAssignmentSnapshot(
  snapshot: {id: number; linkIds: number[]}[],
  transaction?: Transaction,
): Promise<void> {
  const groups = await UsefulLinkGroup.findAll({attributes: ['id'], transaction});
  const validGroups = new Set(groups.map((row) => row.id));
  for (const row of snapshot) {
    if (!validGroups.has(row.id)) {
      throw new Error('Group not found');
    }
  }

  const links = await UsefulLink.findAll({attributes: ['id'], transaction});
  const validLinks = new Set(links.map((row) => row.id));

  await UsefulLinkGroupAssignment.destroy({
    where: {id: {[Op.gt]: 0}},
    transaction,
  });
  const rows: {
    linkId: number;
    groupId: number;
    sortOrder: number;
    createdAt: Date;
    updatedAt: Date;
  }[] = [];
  const now = new Date();
  const seenPair = new Set<string>();
  for (const group of snapshot) {
    group.linkIds.forEach((linkId, index) => {
      if (!validLinks.has(linkId)) return;
      const key = `${linkId}:${group.id}`;
      if (seenPair.has(key)) return;
      seenPair.add(key);
      rows.push({
        linkId,
        groupId: group.id,
        sortOrder: index,
        createdAt: now,
        updatedAt: now,
      });
    });
  }
  if (rows.length) {
    await UsefulLinkGroupAssignment.bulkCreate(rows, {transaction});
  }
  await ensureLinksHaveAGroup(transaction);
}
