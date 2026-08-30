import {Op, type Transaction} from 'sequelize';
import ModTag from '@/models/misc/ModTag.js';
import ModTagAssignment from '@/models/misc/ModTagAssignment.js';

export type SerializedModTag = {
  id: number;
  name: string;
  color: string;
  sortOrder: number;
};

export function serializeModTag(tag: ModTag): SerializedModTag {
  return {
    id: tag.id,
    name: tag.name,
    color: tag.color,
    sortOrder: tag.sortOrder,
  };
}

export async function listModTags(): Promise<SerializedModTag[]> {
  const tags = await ModTag.findAll({
    order: [
      ['sortOrder', 'ASC'],
      ['id', 'ASC'],
    ],
  });
  return tags.map(serializeModTag);
}

export async function replaceModTags(
  modId: number,
  tagIds: number[],
  transaction?: Transaction,
): Promise<SerializedModTag[]> {
  const uniqueIds = [...new Set(tagIds.filter((id) => Number.isInteger(id) && id > 0))];
  const tags = uniqueIds.length
    ? await ModTag.findAll({where: {id: {[Op.in]: uniqueIds}}, transaction})
    : [];
  const found = new Set(tags.map((tag) => tag.id));
  if (found.size !== uniqueIds.length) {
    const error = new Error('Unknown mod tag');
    (error as Error & {status: number}).status = 400;
    throw error;
  }

  await ModTagAssignment.destroy({where: {modId}, transaction});
  if (tags.length) {
    await ModTagAssignment.bulkCreate(
      tags.map((tag) => ({modId, tagId: tag.id})),
      {transaction},
    );
  }
  return tags
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
    .map(serializeModTag);
}

export async function loadTagsByModIds(
  modIds: number[],
): Promise<Map<number, SerializedModTag[]>> {
  const result = new Map<number, SerializedModTag[]>();
  if (!modIds.length) return result;
  const rows = await ModTagAssignment.findAll({
    where: {modId: {[Op.in]: modIds}},
    include: [{model: ModTag, as: 'tag'}],
  });
  for (const row of rows) {
    const tag = (row as ModTagAssignment & {tag?: ModTag}).tag;
    if (!tag) continue;
    const list = result.get(row.modId) || [];
    list.push(serializeModTag(tag));
    result.set(row.modId, list);
  }
  for (const [modId, list] of result) {
    list.sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
    result.set(modId, list);
  }
  return result;
}
