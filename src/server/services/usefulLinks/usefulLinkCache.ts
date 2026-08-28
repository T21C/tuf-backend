import {CacheInvalidation} from '@/server/middleware/cache.js';
import UsefulLinkClusterItem from '@/models/misc/UsefulLinkClusterItem.js';
import UsefulLinkCluster from '@/models/misc/UsefulLinkCluster.js';

export const PUBLIC_CLUSTERS_CACHE_TAG = 'resources:clusters:public';

export function clusterCacheTag(id: number | string): string {
  return `resources:cluster:${id}`;
}

export async function invalidateAllPublicResourceCaches(): Promise<void> {
  await CacheInvalidation.invalidateTags([PUBLIC_CLUSTERS_CACHE_TAG]).catch(() => undefined);
}

export async function invalidatePublicClusterCaches(
  cluster?: {id: number; linkCode?: string | null} | null,
): Promise<void> {
  const tags = [PUBLIC_CLUSTERS_CACHE_TAG];
  if (cluster?.id) tags.push(clusterCacheTag(cluster.id));
  if (cluster?.linkCode) tags.push(clusterCacheTag(cluster.linkCode));
  await CacheInvalidation.invalidateTags(tags).catch(() => undefined);
}

export async function invalidatePublicClustersForLink(linkId: number): Promise<void> {
  const items = await UsefulLinkClusterItem.findAll({
    where: {linkId},
    include: [{model: UsefulLinkCluster, as: 'cluster', attributes: ['id', 'linkCode', 'viewMode']}],
  });
  const tags = new Set<string>([PUBLIC_CLUSTERS_CACHE_TAG]);
  for (const item of items) {
    const cluster = (item as UsefulLinkClusterItem & {cluster?: UsefulLinkCluster}).cluster;
    if (!cluster || cluster.viewMode !== 1) continue;
    tags.add(clusterCacheTag(cluster.id));
    if (cluster.linkCode) tags.add(clusterCacheTag(cluster.linkCode));
  }
  if (tags.size) {
    await CacheInvalidation.invalidateTags([...tags]).catch(() => undefined);
  }
}
