import { Op, Transaction } from 'sequelize';
import { LevelPackItem } from '@/models/packs/index.js';
import Level from '@/models/levels/Level.js';

const PACK_DESCRIPTION_MAX_LENGTH = 2000;
const PACK_ITEM_NAME_MAX_LENGTH = 255;

type PackItemType = 'folder' | 'level' | 'note';

type DraftNode = {
  clientId: number;
  type: PackItemType;
  name: string | null;
  description: string | null;
  levelId: number | null;
  parentClientId: number;
  sortOrder: number;
};

type ExistingItem = {
  id: number;
  type: PackItemType;
  parentId: number;
  name: string | null;
  description: string | null;
  levelId: number | null;
  sortOrder: number;
};

function throwHttp(error: string, code: number, extra?: Record<string, unknown>): never {
  throw extra ? { error, code, ...extra } : { error, code };
}

function normalizeOptionalPlainText(
  value: unknown,
  label: string,
  maxLength: number = PACK_DESCRIPTION_MAX_LENGTH,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throwHttp(`${label} must be a string`, 400);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > maxLength) {
    throwHttp(`${label} cannot exceed ${maxLength} characters`, 400);
  }
  return trimmed;
}

function normalizeItemName(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throwHttp(`${label} is required`, 400);
  }
  const trimmed = value.trim();
  if (trimmed.length > PACK_ITEM_NAME_MAX_LENGTH) {
    throwHttp(`${label} cannot exceed ${PACK_ITEM_NAME_MAX_LENGTH} characters`, 400);
  }
  return trimmed;
}

function flattenDraftItems(
  items: unknown,
  parentClientId = 0,
  acc: DraftNode[] = [],
): DraftNode[] {
  if (!Array.isArray(items)) {
    throwHttp('items must be an array', 400);
  }

  items.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object') {
      throwHttp('Invalid item', 400);
    }
    const item = raw as Record<string, unknown>;
    const clientId = Number(item.id);
    if (!Number.isInteger(clientId) || clientId === 0) {
      throwHttp('Invalid item id', 400);
    }

    const type = item.type;
    if (type !== 'folder' && type !== 'level' && type !== 'note') {
      throwHttp('Type must be "folder", "level", or "note"', 400);
    }

    if (item.children != null && type !== 'folder') {
      throwHttp('Only folders can have children', 400);
    }

    let name: string | null = null;
    let description: string | null = null;
    let levelId: number | null = null;

    if (type === 'folder' || type === 'note') {
      name = normalizeItemName(item.name, type === 'note' ? 'Note title' : 'Folder name');
      description = normalizeOptionalPlainText(
        item.description,
        type === 'note' ? 'Note body' : 'Folder description',
      );
    } else {
      const parsedLevelId = Number(item.levelId);
      if (!Number.isInteger(parsedLevelId) || parsedLevelId <= 0) {
        throwHttp('Valid level ID is required', 400);
      }
      levelId = parsedLevelId;
    }

    acc.push({
      clientId,
      type,
      name,
      description,
      levelId,
      parentClientId,
      sortOrder: index,
    });

    if (type === 'folder') {
      flattenDraftItems(item.children ?? [], clientId, acc);
    }
  });

  return acc;
}

function assertDraftGraph(nodes: DraftNode[], maxItems: number): void {
  if (nodes.length > maxItems) {
    throwHttp(`Maximum ${maxItems} items allowed per pack`, 400);
  }

  const byId = new Map<number, DraftNode>();
  for (const node of nodes) {
    if (byId.has(node.clientId)) {
      throwHttp('Duplicate item id in draft', 400);
    }
    byId.set(node.clientId, node);
  }

  for (const node of nodes) {
    if (node.parentClientId === 0) continue;
    const parent = byId.get(node.parentClientId);
    if (!parent) {
      throwHttp('Invalid parent folder', 400);
    }
    if (parent.type !== 'folder') {
      throwHttp('Items can only be placed inside folders', 400);
    }
  }

  for (const node of nodes) {
    if (node.type !== 'folder') continue;
    const visited = new Set<number>([node.clientId]);
    let currentParentId = node.parentClientId;
    while (currentParentId && currentParentId !== 0) {
      if (visited.has(currentParentId)) {
        throwHttp('Circular reference detected in folder structure', 400);
      }
      visited.add(currentParentId);
      currentParentId = byId.get(currentParentId)?.parentClientId ?? 0;
    }
  }

  const namesByParent = new Map<number, Set<string>>();
  const levelsByParent = new Map<number, Set<number>>();
  for (const node of nodes) {
    if (node.type === 'folder' || node.type === 'note') {
      const names = namesByParent.get(node.parentClientId) ?? new Set<string>();
      if (names.has(node.name!)) {
        throwHttp(`An item named "${node.name}" already exists in this location`, 400);
      }
      names.add(node.name!);
      namesByParent.set(node.parentClientId, names);
    } else if (node.levelId != null) {
      const levels = levelsByParent.get(node.parentClientId) ?? new Set<number>();
      if (levels.has(node.levelId)) {
        throwHttp(`Level #${node.levelId} already exists in the target location`, 400, {
          details: {
            itemId: node.clientId,
            levelId: node.levelId,
            targetParentId: node.parentClientId,
          },
        });
      }
      levels.add(node.levelId);
      levelsByParent.set(node.parentClientId, levels);
    }
  }
}

function resolveParentId(node: DraftNode, idMap: Map<number, number>): number {
  if (node.parentClientId === 0) return 0;
  const mapped = idMap.get(node.parentClientId);
  if (mapped == null) {
    throwHttp('Invalid parent folder', 400);
  }
  return mapped;
}

async function deleteOmittedItems(
  packId: number,
  omittedIds: number[],
  existingById: Map<number, ExistingItem>,
  transaction: Transaction,
): Promise<void> {
  const remaining = new Set(omittedIds);
  while (remaining.size > 0) {
    const leaves = [...remaining].filter((id) => {
      return ![...remaining].some(
        (other) => other !== id && existingById.get(other)?.parentId === id,
      );
    });
    const batch = leaves.length > 0 ? leaves : [...remaining];
    await LevelPackItem.destroy({
      where: { packId, id: { [Op.in]: batch } },
      transaction,
      hooks: false,
    });
    for (const id of batch) remaining.delete(id);
  }
}

export async function commitPackItemDraft({
  packId,
  items,
  maxItems,
  transaction,
}: {
  packId: number;
  items: unknown;
  maxItems: number;
  transaction: Transaction;
}): Promise<void> {
  const draftNodes = flattenDraftItems(items);
  assertDraftGraph(draftNodes, maxItems);

  const existingRows = await LevelPackItem.findAll({
    where: { packId },
    attributes: ['id', 'type', 'parentId', 'name', 'description', 'levelId', 'sortOrder'],
    transaction,
  });

  const existingById = new Map<number, ExistingItem>();
  for (const row of existingRows) {
    const json = row.toJSON() as ExistingItem;
    existingById.set(json.id, {
      id: json.id,
      type: json.type,
      parentId: json.parentId ?? 0,
      name: json.name ?? null,
      description: json.description ?? null,
      levelId: json.levelId ?? null,
      sortOrder: json.sortOrder ?? 0,
    });
  }

  const draftById = new Map(draftNodes.map((node) => [node.clientId, node]));
  const keptNodes = draftNodes.filter((node) => node.clientId > 0);
  const newNodes = draftNodes.filter((node) => node.clientId < 0);

  for (const node of keptNodes) {
    const existing = existingById.get(node.clientId);
    if (!existing) {
      throwHttp('Some items do not belong to this pack', 400);
    }
    if (existing.type !== node.type) {
      throwHttp('Item type cannot be changed', 400);
    }
    if (existing.type === 'level' && existing.levelId !== node.levelId) {
      throwHttp('Level reference cannot be changed', 400);
    }
  }

  const omittedIds = [...existingById.keys()].filter((id) => !draftById.has(id));

  const newLevelIds = [
    ...new Set(
      newNodes
        .filter((node) => node.type === 'level' && node.levelId != null)
        .map((node) => node.levelId!),
    ),
  ];
  if (newLevelIds.length > 0) {
    const foundLevels = await Level.findAll({
      where: { id: { [Op.in]: newLevelIds } },
      attributes: ['id'],
      transaction,
    });
    const found = new Set(foundLevels.map((level) => level.id));
    for (const levelId of newLevelIds) {
      if (!found.has(levelId)) {
        throwHttp(`Level #${levelId} not found`, 400);
      }
    }
  }

  const idMap = new Map<number, number>();
  for (const node of keptNodes) {
    idMap.set(node.clientId, node.clientId);
  }

  const writeOptions = { transaction, hooks: false as const };

  const createNewOfType = async (type: PackItemType) => {
    const remaining = newNodes.filter((node) => node.type === type && !idMap.has(node.clientId));
    while (remaining.length > 0) {
      const readyIndex = remaining.findIndex(
        (node) => node.parentClientId === 0 || idMap.has(node.parentClientId),
      );
      if (readyIndex < 0) {
        throwHttp('Invalid parent folder', 400);
      }
      const [node] = remaining.splice(readyIndex, 1);
      const created = await LevelPackItem.create(
        {
          packId,
          type: node.type,
          parentId: resolveParentId(node, idMap),
          name: node.name,
          description: node.description,
          levelId: node.levelId,
          sortOrder: node.sortOrder,
        },
        writeOptions,
      );
      idMap.set(node.clientId, created.id);
    }
  };

  await createNewOfType('folder');
  await createNewOfType('note');

  for (const node of keptNodes) {
    const existing = existingById.get(node.clientId)!;
    const parentId = resolveParentId(node, idMap);
    const updates: Record<string, unknown> = {
      parentId,
      sortOrder: node.sortOrder,
    };
    if (existing.type === 'folder' || existing.type === 'note') {
      updates.name = node.name;
      updates.description = node.description;
    }
    if (existing.type === 'level') {
      updates.levelId = null;
    }
    await LevelPackItem.update(updates, {
      where: { id: node.clientId, packId },
      transaction,
      hooks: false,
    });
  }

  for (const node of keptNodes) {
    const existing = existingById.get(node.clientId)!;
    if (existing.type !== 'level') continue;
    await LevelPackItem.update(
      { levelId: existing.levelId },
      {
        where: { id: node.clientId, packId },
        transaction,
        hooks: false,
      },
    );
  }

  if (omittedIds.length > 0) {
    await deleteOmittedItems(packId, omittedIds, existingById, transaction);
  }

  await createNewOfType('level');
}
