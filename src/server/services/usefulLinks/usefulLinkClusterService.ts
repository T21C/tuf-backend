import {Transaction} from 'sequelize';
import User from '@/models/auth/User.js';
import UsefulLink from '@/models/misc/UsefulLink.js';
import UsefulLinkCluster from '@/models/misc/UsefulLinkCluster.js';
import UsefulLinkClusterItem from '@/models/misc/UsefulLinkClusterItem.js';
import UsefulLinkClusterLocaleDefault from '@/models/misc/UsefulLinkClusterLocaleDefault.js';
import {serializeUsefulLink, type UsefulLinkJson} from './serializeUsefulLink.js';
import {LINK_LOCALES_INCLUDE} from './usefulLinkGroupService.js';
import {
  LINK_TAGS_INCLUDE,
  compareSerializedTagOrder,
  serializeUsefulLinkTag,
  type UsefulLinkTagJson,
} from './usefulLinkTagService.js';
import {getFileIdFromCdnUrl, isCdnUrl} from '@/misc/utils/Utility.js';
import cdnService from '@/server/services/core/CdnService.js';
import {logger} from '@/server/services/core/LoggerService.js';
import {
  checkPublishReady,
  itemHasLocale,
  itemsByLocale,
  localesOnItem,
  type PublishCheckResult,
} from './usefulLinkClusterPublish.js';

export {
  checkPublishReady,
  itemHasLocale,
  itemsByLocale,
  localesOnItem,
  type PublishCheckResult,
};

export type ClusterOwnerJson = {
  id: string;
  username: string;
  nickname: string | null;
  avatarUrl: string | null;
};

export type ClusterLocaleDefaultJson = {
  languageCode: string;
  itemId: number;
};

export type ClusterItemJson = {
  id: number;
  clusterId: number;
  linkId: number | null;
  sortOrder: number;
  link: UsefulLinkJson | null;
};

export type ClusterJson = {
  id: string;
  numericId: number;
  ownerId: string;
  name: string;
  description: string | null;
  iconUrl: string | null;
  viewMode: number;
  linkCode: string;
  isPinned: boolean;
  isOfficial: boolean;
  owner: ClusterOwnerJson | null;
  itemCount: number;
  tags?: UsefulLinkTagJson[];
  items?: ClusterItemJson[];
  localeDefaults?: ClusterLocaleDefaultJson[];
  createdAt: Date;
  updatedAt: Date;
};

const LINK_INCLUDE = {
  model: UsefulLink,
  as: 'link',
  required: false,
  include: [LINK_TAGS_INCLUDE, LINK_LOCALES_INCLUDE],
};

export async function loadOwnersByIds(ownerIds: string[]): Promise<Map<string, ClusterOwnerJson>> {
  const unique = [...new Set(ownerIds.filter(Boolean))];
  const map = new Map<string, ClusterOwnerJson>();
  if (!unique.length) return map;
  const users = await User.findAll({
    where: {id: unique},
    attributes: ['id', 'username', 'nickname', 'avatarUrl'],
  });
  for (const user of users) {
    map.set(user.id, {
      id: user.id,
      username: user.username,
      nickname: user.nickname ?? null,
      avatarUrl: user.avatarUrl ?? null,
    });
  }
  return map;
}

export function serializeCluster(
  cluster: UsefulLinkCluster,
  opts?: {
    owner?: ClusterOwnerJson | null;
    items?: ClusterItemJson[];
    localeDefaults?: ClusterLocaleDefaultJson[];
    itemCount?: number;
    tags?: UsefulLinkTagJson[];
  },
): ClusterJson {
  return {
    id: cluster.linkCode,
    numericId: cluster.id,
    ownerId: cluster.ownerId,
    name: cluster.name,
    description: cluster.description ?? null,
    iconUrl: cluster.iconUrl ?? null,
    viewMode: cluster.viewMode,
    linkCode: cluster.linkCode,
    isPinned: Boolean(cluster.isPinned),
    isOfficial: Boolean(cluster.isOfficial),
    owner: opts?.owner ?? null,
    itemCount: opts?.itemCount ?? opts?.items?.length ?? 0,
    tags: opts?.tags,
    items: opts?.items,
    localeDefaults: opts?.localeDefaults,
    createdAt: cluster.createdAt,
    updatedAt: cluster.updatedAt,
  };
}

export function serializeClusterItem(item: UsefulLinkClusterItem): ClusterItemJson {
  const link = (item as UsefulLinkClusterItem & {link?: UsefulLink | null}).link ?? null;
  return {
    id: item.id,
    clusterId: item.clusterId,
    linkId: item.linkId ?? null,
    sortOrder: item.sortOrder,
    link: link ? serializeUsefulLink(link) : null,
  };
}

export async function resolveCluster(
  param: string,
  transaction?: Transaction,
): Promise<UsefulLinkCluster | null> {
  const raw = String(param || '').trim();
  if (!raw) return null;
  const byCode = await UsefulLinkCluster.findOne({
    where: {linkCode: raw},
    transaction,
  });
  if (byCode) return byCode;
  if (/^[0-9]{1,20}$/.test(raw)) {
    return UsefulLinkCluster.findByPk(raw, {transaction});
  }
  return null;
}

export async function loadClusterItems(
  clusterId: number,
  transaction?: Transaction,
): Promise<ClusterItemJson[]> {
  const items = await UsefulLinkClusterItem.findAll({
    where: {clusterId},
    include: [LINK_INCLUDE],
    order: [
      ['sortOrder', 'ASC'],
      ['id', 'ASC'],
    ],
    transaction,
  });
  return items.map(serializeClusterItem);
}

export async function loadTagsByClusterIds(
  clusterIds: number[],
  transaction?: Transaction,
): Promise<Map<number, UsefulLinkTagJson[]>> {
  const map = new Map<number, UsefulLinkTagJson[]>();
  if (!clusterIds.length) return map;

  const items = await UsefulLinkClusterItem.findAll({
    where: {clusterId: clusterIds},
    attributes: ['clusterId', 'linkId'],
    include: [
      {
        model: UsefulLink,
        as: 'link',
        required: true,
        attributes: ['id'],
        include: [LINK_TAGS_INCLUDE],
      },
    ],
    transaction,
  });

  for (const item of items) {
    const tags = item.link?.tags ?? [];
    if (!tags.length) continue;
    const current = map.get(item.clusterId) ?? [];
    const seen = new Set(current.map((row) => row.id));
    for (const tag of tags) {
      const serialized = serializeUsefulLinkTag(tag);
      if (seen.has(serialized.id)) continue;
      seen.add(serialized.id);
      current.push(serialized);
    }
    map.set(item.clusterId, current);
  }

  for (const [clusterId, tags] of map.entries()) {
    map.set(clusterId, [...tags].sort(compareSerializedTagOrder));
  }
  return map;
}

export async function loadLocaleDefaults(
  clusterId: number,
  transaction?: Transaction,
): Promise<ClusterLocaleDefaultJson[]> {
  const rows = await UsefulLinkClusterLocaleDefault.findAll({
    where: {clusterId},
    transaction,
  });
  return rows.map((row) => ({
    languageCode: row.languageCode,
    itemId: row.itemId,
  }));
}

export async function loadSerializedCluster(
  cluster: UsefulLinkCluster,
  opts?: {includeItems?: boolean; transaction?: Transaction},
): Promise<ClusterJson> {
  const owners = await loadOwnersByIds([cluster.ownerId]);
  const items = opts?.includeItems
    ? await loadClusterItems(cluster.id, opts.transaction)
    : undefined;
  const localeDefaults = opts?.includeItems
    ? await loadLocaleDefaults(cluster.id, opts.transaction)
    : undefined;
  const itemCount =
    items?.length ??
    (await UsefulLinkClusterItem.count({where: {clusterId: cluster.id}, transaction: opts?.transaction}));
  return serializeCluster(cluster, {
    owner: owners.get(cluster.ownerId) ?? null,
    items,
    localeDefaults,
    itemCount,
  });
}

export async function syncClusterLocaleDefaults(
  clusterId: number,
  transaction?: Transaction,
): Promise<void> {
  const items = await loadClusterItems(clusterId, transaction);
  const byLocale = itemsByLocale(items);
  const existing = await UsefulLinkClusterLocaleDefault.findAll({
    where: {clusterId},
    transaction,
  });
  const existingByCode = new Map(existing.map((row) => [row.languageCode, row]));
  const liveCodes = new Set(byLocale.keys());

  for (const row of existing) {
    const live = byLocale.get(row.languageCode) ?? [];
    const stillValid = live.some((item) => item.id === row.itemId);
    if (!liveCodes.has(row.languageCode) || !stillValid) {
      await row.destroy({transaction});
      existingByCode.delete(row.languageCode);
    }
  }

  for (const [code, live] of byLocale.entries()) {
    if (live.length !== 1) continue;
    const current = existingByCode.get(code);
    if (current) {
      if (current.itemId !== live[0].id) {
        await current.update({itemId: live[0].id}, {transaction});
      }
      continue;
    }
    await UsefulLinkClusterLocaleDefault.create(
      {
        clusterId,
        languageCode: code,
        itemId: live[0].id,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {transaction},
    );
  }
}

export function generateLinkCode(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export async function createUniqueLinkCode(transaction?: Transaction): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const code = generateLinkCode();
    const existing = await UsefulLinkCluster.findOne({where: {linkCode: code}, transaction});
    if (!existing) return code;
  }
  return `${generateLinkCode()}x`;
}

export async function deleteCdnClusterIcon(iconUrl: string | null | undefined): Promise<void> {
  if (!iconUrl || !isCdnUrl(iconUrl)) return;
  const fileId = getFileIdFromCdnUrl(iconUrl);
  if (!fileId) return;
  try {
    if (await cdnService.checkFileExists(fileId)) {
      await cdnService.deleteFile(fileId);
    }
  } catch (error) {
    logger.error('Error deleting cluster icon from CDN:', error);
  }
}
