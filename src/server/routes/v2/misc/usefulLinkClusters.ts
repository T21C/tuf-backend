import {Router, Request, Response} from 'express';
import {Op} from 'sequelize';
import {Auth} from '@/server/middleware/auth.js';
import {ApiDoc} from '@/server/middleware/apiDoc.js';
import {Cache} from '@/server/middleware/cache.js';
import {getSequelizeForModelGroup} from '@/config/db.js';
import {respondMysqlClientError} from '@/misc/utils/db/mysqlClientError.js';
import {permissionFlags} from '@/config/constants.js';
import {hasFlag} from '@/misc/utils/auth/permissionUtils.js';
import {isTufStellarAccessActive} from '@/misc/utils/subscriptions/tufStellarSubscription.js';
import {loadUserTufStellarBilling} from '@/server/services/billing/userTufStellarBillingSupport.js';
import {multerMemoryCdnImage5Mb as upload} from '@/config/multerMemoryUploads.js';
import cdnService, {CdnError, respondWithCdnError} from '@/server/services/core/CdnService.js';
import User from '@/models/auth/User.js';
import UsefulLink from '@/models/misc/UsefulLink.js';
import UsefulLinkCluster from '@/models/misc/UsefulLinkCluster.js';
import UsefulLinkClusterItem from '@/models/misc/UsefulLinkClusterItem.js';
import UsefulLinkClusterLocaleDefault from '@/models/misc/UsefulLinkClusterLocaleDefault.js';
import UsefulLinkTag from '@/models/misc/UsefulLinkTag.js';
import UsefulLinkTagAssignment from '@/models/misc/UsefulLinkTagAssignment.js';
import {
  parseSearchQuery,
  queryParserConfigs,
  type FieldSearch,
  type SearchGroup,
} from '@/misc/utils/data/queryParser.js';
import {
  parseHttpUrl,
  parseLocaleFields,
  parseSortOrders,
  parseTagIds,
  parseTitle,
  DESCRIPTION_MAX,
} from '@/server/services/usefulLinks/usefulLinkFields.js';
import UsefulLinkLocale from '@/models/misc/UsefulLinkLocale.js';
import {
  DEFAULT_SITE_LANGUAGE,
  isConfiguredSiteLanguage,
  siteLanguageCodesMatchingQuery,
} from '@/config/siteLanguages.js';
import {replaceLinkTags} from '@/server/services/usefulLinks/usefulLinkTagService.js';
import {upsertEnglishLocale, loadSerializedLink} from '@/server/services/usefulLinks/usefulLinkGroupService.js';
import {
  PUBLIC_CLUSTERS_CACHE_TAG,
  clusterCacheTag,
  invalidatePublicClusterCaches,
} from '@/server/services/usefulLinks/usefulLinkCache.js';
import {
  DEFAULT_MAX_CLUSTERS_PER_USER,
  DEFAULT_MAX_ITEMS_PER_CLUSTER,
  TUF_STELLAR_MAX_CLUSTERS_PER_USER,
  TUF_STELLAR_MAX_ITEMS_PER_CLUSTER,
  UsefulLinkClusterViewModes,
  canEditCluster,
  canViewCluster,
  isPublishTransition,
  ownerMaySetViewMode,
} from '@/server/services/usefulLinks/usefulLinkClusterAccess.js';
import {
  checkPublishReady,
  createUniqueLinkCode,
  deleteCdnClusterIcon,
  loadClusterItems,
  loadLocaleDefaults,
  loadOwnersByIds,
  loadSerializedCluster,
  loadTagsByClusterIds,
  resolveCluster,
  serializeCluster,
  syncClusterLocaleDefaults,
} from '@/server/services/usefulLinks/usefulLinkClusterService.js';
import {logger} from '@/server/services/core/LoggerService.js';

const router: Router = Router();
const sequelize = getSequelizeForModelGroup('admin');
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
const CLUSTER_NAME_MAX = 255;

const sortableFields = {
  RECENT: 'createdAt',
  NAME: 'name',
} as const;

function isAdmin(user: Request['user']): boolean {
  return Boolean(user && hasFlag(user, permissionFlags.SUPER_ADMIN));
}

async function resolveQuota(user: NonNullable<Request['user']>): Promise<{
  maxClusters: number;
  maxItems: number;
}> {
  if (isAdmin(user)) {
    return {maxClusters: Number.MAX_SAFE_INTEGER, maxItems: Number.MAX_SAFE_INTEGER};
  }
  const billing = await loadUserTufStellarBilling(user.id);
  if (isTufStellarAccessActive(user, billing)) {
    return {
      maxClusters: TUF_STELLAR_MAX_CLUSTERS_PER_USER,
      maxItems: TUF_STELLAR_MAX_ITEMS_PER_CLUSTER,
    };
  }
  return {maxClusters: DEFAULT_MAX_CLUSTERS_PER_USER, maxItems: DEFAULT_MAX_ITEMS_PER_CLUSTER};
}

function parseViewMode(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (
    n === UsefulLinkClusterViewModes.PUBLIC ||
    n === UsefulLinkClusterViewModes.LINKONLY ||
    n === UsefulLinkClusterViewModes.PRIVATE
  ) {
    return n;
  }
  return undefined;
}

function parseClusterName(raw: unknown): {ok: true; value: string} | {ok: false; error: string} {
  if (typeof raw !== 'string') return {ok: false, error: 'name is required'};
  const name = raw.trim();
  if (!name) return {ok: false, error: 'name is required'};
  if (name.length > CLUSTER_NAME_MAX) return {ok: false, error: 'name is too long'};
  return {ok: true, value: name};
}

function parseDescription(raw: unknown): {ok: true; value: string | null} | {ok: false; error: string} {
  if (raw === undefined || raw === null) return {ok: true, value: null};
  if (typeof raw !== 'string') return {ok: false, error: 'description must be a string'};
  const trimmed = raw.trim();
  if (!trimmed) return {ok: true, value: null};
  if (trimmed.length > DESCRIPTION_MAX) {
    return {ok: false, error: `description cannot exceed ${DESCRIPTION_MAX} characters`};
  }
  return {ok: true, value: trimmed};
}

async function invertClusterIds(ids: number[], isNot: boolean): Promise<number[]> {
  const unique = [...new Set(ids)];
  if (!isNot) return unique;
  const rows = await UsefulLinkCluster.findAll({
    where: unique.length ? {id: {[Op.notIn]: unique}} : {},
    attributes: ['id'],
  });
  return rows.map((row) => row.id);
}

async function clusterIdsForLinkIds(linkIds: number[]): Promise<number[]> {
  const unique = [...new Set(linkIds)];
  if (!unique.length) return [];
  const items = await UsefulLinkClusterItem.findAll({
    where: {linkId: unique},
    attributes: ['clusterId'],
  });
  return [...new Set(items.map((row) => row.clusterId))];
}

async function clusterIdsMatchingName(value: string, exact: boolean): Promise<number[]> {
  const where = exact
    ? {name: value}
    : {
        [Op.or]: [
          {name: {[Op.like]: `%${value}%`}},
          {description: {[Op.like]: `%${value}%`}},
        ],
      };
  const rows = await UsefulLinkCluster.findAll({where, attributes: ['id']});
  return rows.map((row) => row.id);
}

async function clusterIdsMatchingOwner(value: string, exact: boolean): Promise<number[]> {
  const where = exact
    ? {[Op.or]: [{username: value}, {nickname: value}]}
    : {
        [Op.or]: [
          {username: {[Op.like]: `%${value}%`}},
          {nickname: {[Op.like]: `%${value}%`}},
        ],
      };
  const owners = await User.findAll({where, attributes: ['id']});
  if (!owners.length) return [];
  const rows = await UsefulLinkCluster.findAll({
    where: {ownerId: owners.map((row) => row.id)},
    attributes: ['id'],
  });
  return rows.map((row) => row.id);
}

async function clusterIdsMatchingTag(value: string, exact: boolean): Promise<number[]> {
  const where = exact ? {name: value} : {name: {[Op.like]: `%${value}%`}};
  const tags = await UsefulLinkTag.findAll({where, attributes: ['id']});
  if (!tags.length) return [];
  const assignments = await UsefulLinkTagAssignment.findAll({
    where: {tagId: tags.map((row) => row.id)},
    attributes: ['linkId'],
  });
  return clusterIdsForLinkIds(assignments.map((row) => row.linkId));
}

async function clusterIdsMatchingLinkTitle(value: string, exact: boolean): Promise<number[]> {
  const titleWhere = exact ? {title: value} : {title: {[Op.like]: `%${value}%`}};
  const [links, locales] = await Promise.all([
    UsefulLink.findAll({where: titleWhere, attributes: ['id']}),
    UsefulLinkLocale.findAll({where: titleWhere, attributes: ['linkId']}),
  ]);
  return clusterIdsForLinkIds([
    ...links.map((row) => row.id),
    ...locales.map((row) => row.linkId),
  ]);
}

async function clusterIdsMatchingLanguage(value: string, exact: boolean): Promise<number[]> {
  const codes = siteLanguageCodesMatchingQuery(value, exact);
  if (!codes.length) return [];
  const locales = await UsefulLinkLocale.findAll({
    where: {languageCode: codes},
    attributes: ['linkId'],
  });
  return clusterIdsForLinkIds(locales.map((row) => row.linkId));
}

async function clusterIdsForSearchTerm(term: FieldSearch): Promise<number[]> {
  const {field, value, exact, isNot} = term;
  if (!value) return invertClusterIds([], isNot);

  let ids: number[] = [];
  if (field === 'any') {
    const [nameIds, ownerIds, tagIds, titleIds, languageIds] = await Promise.all([
      clusterIdsMatchingName(value, exact),
      clusterIdsMatchingOwner(value, exact),
      clusterIdsMatchingTag(value, exact),
      clusterIdsMatchingLinkTitle(value, exact),
      clusterIdsMatchingLanguage(value, exact),
    ]);
    ids = [...nameIds, ...ownerIds, ...tagIds, ...titleIds, ...languageIds];
  } else if (field === 'name') {
    ids = await clusterIdsMatchingName(value, exact);
  } else if (field === 'owner') {
    ids = await clusterIdsMatchingOwner(value, exact);
  } else if (field === 'tag') {
    ids = await clusterIdsMatchingTag(value, exact);
  } else if (field === 'language' || field === 'lang') {
    ids = await clusterIdsMatchingLanguage(value, exact);
  }
  return invertClusterIds(ids, isNot);
}

async function gatherClusterIdsFromSearch(searchGroups: SearchGroup[]): Promise<Set<number>> {
  if (!searchGroups.length) return new Set();
  const groupResults: Set<number>[] = [];

  for (const group of searchGroups) {
    const termSets: Set<number>[] = [];
    for (const term of group.terms) {
      termSets.push(new Set(await clusterIdsForSearchTerm(term)));
    }
    if (termSets.length) {
      let combined = termSets[0];
      for (let i = 1; i < termSets.length; i++) {
        combined = new Set([...combined].filter((id) => termSets[i].has(id)));
      }
      groupResults.push(combined);
    }
  }

  if (!groupResults.length) return new Set();
  let finalSet = groupResults[0];
  for (let i = 1; i < groupResults.length; i++) {
    finalSet = new Set([...finalSet, ...groupResults[i]]);
  }
  return finalSet;
}

function deny(res: Response, code: number, error: string) {
  return res.status(code).json({error});
}

router.get(
  '/',
  Auth.addUserToRequest(),
  ApiDoc({
    operationId: 'listUsefulLinkClusters',
    summary: 'List useful link clusters',
    tags: ['Misc', 'Useful Links'],
    responses: {200: {description: 'Clusters list'}},
  }),
  Cache({
    ttl: 3600,
    skipIf: (req) => Boolean(req.user),
    varyByQuery: ['query', 'viewMode', 'pinned', 'official', 'offset', 'limit', 'sort', 'order', 'mine'],
    tags: [PUBLIC_CLUSTERS_CACHE_TAG],
  }),
  async (req: Request, res: Response) => {
    try {
      let {offset, limit} = req.query as {offset?: string; limit?: string};
      const {
        query,
        viewMode,
        pinned,
        official,
        sort = 'RECENT',
        order: orderQuery = 'DESC',
        mine,
      } = req.query as Record<string, string | undefined>;

      const parsedLimit = Math.min(Number(limit) || DEFAULT_LIMIT, MAX_LIMIT);
      const parsedOffset = Math.max(Number(offset) || 0, 0);
      const sortField =
        sortableFields[sort as keyof typeof sortableFields] || 'createdAt';
      const order = orderQuery === 'ASC' ? 'ASC' : 'DESC';

      const where: Record<string, unknown> = {};
      if (viewMode !== undefined && isAdmin(req.user)) {
        const parsed = parseViewMode(viewMode);
        if (parsed !== undefined) where.viewMode = parsed;
      }
      if (pinned !== undefined) where.isPinned = pinned === 'true';
      if (official !== undefined) where.isOfficial = official === 'true';

      if (query) {
        const groups = parseSearchQuery(query, queryParserConfigs.usefulLinkCluster);
        const ids = await gatherClusterIdsFromSearch(groups);
        if (!ids.size) {
          return res.json({clusters: [], total: 0, offset: parsedOffset, limit: parsedLimit});
        }
        where.id = {[Op.in]: [...ids]};
      }

      const visibility: Record<string, unknown>[] = [{viewMode: UsefulLinkClusterViewModes.PUBLIC}];
      if (req.user?.id) {
        visibility.push({ownerId: req.user.id});
        if (isAdmin(req.user)) {
          visibility.length = 0;
          visibility.push({});
        }
      }
      if (mine === 'true') {
        if (!req.user?.id) {
          return res.json({clusters: [], total: 0, offset: parsedOffset, limit: parsedLimit});
        }
        where.ownerId = req.user.id;
      }

      const rows = await UsefulLinkCluster.findAll({
        where: {
          ...where,
          ...(visibility.length && visibility[0] && Object.keys(visibility[0]).length
            ? {[Op.or]: visibility}
            : {}),
        },
        order: [
          ['isPinned', 'DESC'],
          ['isOfficial', 'DESC'],
          [sortField, order],
        ],
      });

      const visible = rows.filter((cluster) =>
        canViewCluster(cluster, req.user, hasFlag, permissionFlags.SUPER_ADMIN),
      );
      const total = visible.length;
      const page = visible.slice(parsedOffset, parsedOffset + parsedLimit);
      const owners = await loadOwnersByIds(page.map((row) => row.ownerId));
      const tagsByCluster = await loadTagsByClusterIds(page.map((row) => row.id));
      const counts = await Promise.all(
        page.map((row) => UsefulLinkClusterItem.count({where: {clusterId: row.id}})),
      );

      return res.json({
        clusters: page.map((cluster, index) =>
          serializeCluster(cluster, {
            owner: owners.get(cluster.ownerId) ?? null,
            itemCount: counts[index],
            tags: tagsByCluster.get(cluster.id) ?? [],
          }),
        ),
        total,
        offset: parsedOffset,
        limit: parsedLimit,
      });
    } catch (error) {
      logger.error('List useful link clusters failed:', error);
      return respondMysqlClientError(res, error, 'Failed to list clusters', {
        logLabel: 'List useful link clusters failed:',
      });
    }
  },
);

router.post(
  '/',
  Auth.user(),
  ApiDoc({
    operationId: 'createUsefulLinkCluster',
    summary: 'Create a useful link cluster',
    tags: ['Misc', 'Useful Links'],
    security: ['bearerAuth'],
    responses: {201: {description: 'Created'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const name = parseClusterName(req.body?.name);
      if (!name.ok) return deny(res, 400, name.error);
      const description = parseDescription(req.body?.description);
      if (!description.ok) return deny(res, 400, description.error);

      const requestedMode = parseViewMode(req.body?.viewMode);
      let viewMode = requestedMode ?? UsefulLinkClusterViewModes.PRIVATE;
      let isPinned = false;
      let isOfficial = false;

      if (isAdmin(req.user)) {
        if (typeof req.body?.isPinned === 'boolean') isPinned = req.body.isPinned;
        if (typeof req.body?.isOfficial === 'boolean') isOfficial = req.body.isOfficial;
      } else {
        if (viewMode === UsefulLinkClusterViewModes.PUBLIC) {
          return deny(res, 403, 'Only administrators can create public clusters');
        }
        if (req.body?.isPinned || req.body?.isOfficial) {
          return deny(res, 403, 'Only administrators can pin or mark clusters official');
        }
      }

      const quota = await resolveQuota(req.user!);
      const owned = await UsefulLinkCluster.count({where: {ownerId: req.user!.id}});
      if (owned >= quota.maxClusters) {
        return deny(res, 400, `Maximum ${quota.maxClusters} clusters allowed per user`);
      }

      const cluster = await sequelize.transaction(async (transaction) => {
        return UsefulLinkCluster.create(
          {
            ownerId: req.user!.id,
            name: name.value,
            description: description.value,
            iconUrl: null,
            viewMode,
            linkCode: await createUniqueLinkCode(transaction),
            isPinned,
            isOfficial,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          {transaction},
        );
      });

      if (cluster.viewMode === UsefulLinkClusterViewModes.PUBLIC) {
        await invalidatePublicClusterCaches(cluster);
      }
      return res.status(201).json(await loadSerializedCluster(cluster, {includeItems: true}));
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to create cluster', {
        logLabel: 'Create useful link cluster failed:',
      });
    }
  },
);

router.get(
  '/:id',
  Auth.addUserToRequest(),
  ApiDoc({
    operationId: 'getUsefulLinkCluster',
    summary: 'Get a useful link cluster',
    tags: ['Misc', 'Useful Links'],
    responses: {200: {description: 'Cluster detail'}},
  }),
  Cache({
    ttl: 3600,
    skipIf: (req) => Boolean(req.user),
    tags: (req) => [PUBLIC_CLUSTERS_CACHE_TAG, clusterCacheTag(String(req.params.id))],
  }),
  async (req: Request, res: Response) => {
    try {
      const cluster = await resolveCluster(req.params.id);
      if (!cluster) return deny(res, 404, 'Cluster not found');
      if (!canViewCluster(cluster, req.user, hasFlag, permissionFlags.SUPER_ADMIN)) {
        return deny(res, 404, 'Cluster not found');
      }
      return res.json(await loadSerializedCluster(cluster, {includeItems: true}));
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to load cluster', {
        logLabel: 'Get useful link cluster failed:',
      });
    }
  },
);

router.patch(
  '/:id',
  Auth.user(),
  ApiDoc({
    operationId: 'patchUsefulLinkCluster',
    summary: 'Update a useful link cluster',
    tags: ['Misc', 'Useful Links'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Updated'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const cluster = await resolveCluster(req.params.id);
      if (!cluster) return deny(res, 404, 'Cluster not found');
      if (!canEditCluster(cluster, req.user, hasFlag, permissionFlags.SUPER_ADMIN)) {
        return deny(res, 403, 'Access denied');
      }

      const updates: Record<string, unknown> = {};
      if (req.body?.name !== undefined) {
        const name = parseClusterName(req.body.name);
        if (!name.ok) return deny(res, 400, name.error);
        updates.name = name.value;
      }
      if (req.body?.description !== undefined) {
        const description = parseDescription(req.body.description);
        if (!description.ok) return deny(res, 400, description.error);
        updates.description = description.value;
      }

      const nextMode = parseViewMode(req.body?.viewMode);
      if (nextMode !== undefined) {
        if (isAdmin(req.user)) {
          if (isPublishTransition(cluster.viewMode, nextMode)) {
            const items = await loadClusterItems(cluster.id);
            const defaults = await loadLocaleDefaults(cluster.id);
            const check = checkPublishReady(items, defaults);
            if (!check.ok) return deny(res, 400, check.error);
          }
          updates.viewMode = nextMode;
        } else if (!ownerMaySetViewMode(cluster.viewMode, nextMode)) {
          return deny(res, 403, 'Only administrators can publish or unpublish clusters');
        } else {
          updates.viewMode = nextMode;
        }
      }

      if (req.body?.isPinned !== undefined) {
        if (!isAdmin(req.user)) return deny(res, 403, 'Only administrators can pin clusters');
        if (typeof req.body.isPinned !== 'boolean') {
          return deny(res, 400, 'isPinned must be a boolean');
        }
        updates.isPinned = req.body.isPinned;
      }
      if (req.body?.isOfficial !== undefined) {
        if (!isAdmin(req.user)) {
          return deny(res, 403, 'Only administrators can mark clusters official');
        }
        if (typeof req.body.isOfficial !== 'boolean') {
          return deny(res, 400, 'isOfficial must be a boolean');
        }
        updates.isOfficial = req.body.isOfficial;
      }

      if (!Object.keys(updates).length) return deny(res, 400, 'No fields to update');
      await cluster.update(updates);
      await invalidatePublicClusterCaches(cluster);
      return res.json(await loadSerializedCluster(cluster, {includeItems: true}));
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to update cluster', {
        logLabel: 'Update useful link cluster failed:',
      });
    }
  },
);

router.delete(
  '/:id',
  Auth.user(),
  ApiDoc({
    operationId: 'deleteUsefulLinkCluster',
    summary: 'Delete a useful link cluster',
    tags: ['Misc', 'Useful Links'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Deleted'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const cluster = await resolveCluster(req.params.id);
      if (!cluster) return deny(res, 404, 'Cluster not found');
      if (!canEditCluster(cluster, req.user, hasFlag, permissionFlags.SUPER_ADMIN)) {
        return deny(res, 403, 'Access denied');
      }
      const iconUrl = cluster.iconUrl;
      await cluster.destroy();
      await deleteCdnClusterIcon(iconUrl);
      await invalidatePublicClusterCaches(cluster);
      return res.json({success: true});
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to delete cluster', {
        logLabel: 'Delete useful link cluster failed:',
      });
    }
  },
);

router.post(
  '/:id/icon',
  Auth.user(),
  upload.single('icon'),
  ApiDoc({
    operationId: 'postUsefulLinkClusterIcon',
    summary: 'Upload a cluster icon',
    description: 'Upload a cluster icon (JPEG/PNG/WebP/GIF, max 5MB).',
    tags: ['Misc', 'Useful Links'],
    security: ['bearerAuth'],
    requestBody: {
      description: 'multipart/form-data with icon file (JPEG/PNG/WebP/GIF, max 5MB)',
      schema: {type: 'object', properties: {icon: {type: 'string', format: 'binary'}}},
      required: true,
    },
    responses: {200: {description: 'Icon uploaded'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const cluster = await resolveCluster(req.params.id);
      if (!cluster) return deny(res, 404, 'Cluster not found');
      if (!canEditCluster(cluster, req.user, hasFlag, permissionFlags.SUPER_ADMIN)) {
        return deny(res, 403, 'Access denied');
      }
      if (!req.file) {
        return deny(res, 400, 'No file uploaded');
      }

      const result = await cdnService.uploadImage(
        req.file.buffer,
        req.file.originalname,
        'CLUSTER_ICON',
      );
      const previousIconUrl = cluster.iconUrl;
      await cluster.update({iconUrl: result.urls.original});
      await deleteCdnClusterIcon(previousIconUrl);
      await invalidatePublicClusterCaches(cluster);
      return res.json(await loadSerializedCluster(cluster, {includeItems: true}));
    } catch (error) {
      logger.error('Error uploading cluster icon:', error);
      if (error instanceof CdnError) {
        return respondWithCdnError(res, error);
      }
      return res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to upload cluster icon',
      });
    }
  },
);

router.delete(
  '/:id/icon',
  Auth.user(),
  ApiDoc({
    operationId: 'deleteUsefulLinkClusterIcon',
    summary: 'Remove a cluster icon',
    tags: ['Misc', 'Useful Links'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Icon removed'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const cluster = await resolveCluster(req.params.id);
      if (!cluster) return deny(res, 404, 'Cluster not found');
      if (!canEditCluster(cluster, req.user, hasFlag, permissionFlags.SUPER_ADMIN)) {
        return deny(res, 403, 'Access denied');
      }
      if (!cluster.iconUrl) {
        return deny(res, 400, 'No icon to remove');
      }
      const previousIconUrl = cluster.iconUrl;
      await cluster.update({iconUrl: null});
      await deleteCdnClusterIcon(previousIconUrl);
      await invalidatePublicClusterCaches(cluster);
      return res.json(await loadSerializedCluster(cluster, {includeItems: true}));
    } catch (error) {
      logger.error('Error removing cluster icon:', error);
      return res.status(500).json({error: 'Failed to remove cluster icon'});
    }
  },
);

router.post(
  '/:id/items',
  Auth.user(),
  ApiDoc({
    operationId: 'addUsefulLinkClusterItem',
    summary: 'Add a catalog or custom link to a cluster',
    tags: ['Misc', 'Useful Links'],
    security: ['bearerAuth'],
    responses: {201: {description: 'Item added'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const cluster = await resolveCluster(req.params.id);
      if (!cluster) return deny(res, 404, 'Cluster not found');
      if (!canEditCluster(cluster, req.user, hasFlag, permissionFlags.SUPER_ADMIN)) {
        return deny(res, 403, 'Access denied');
      }
      const quota = await resolveQuota(req.user!);
      const itemCount = await UsefulLinkClusterItem.count({where: {clusterId: cluster.id}});
      if (itemCount >= quota.maxItems) {
        return deny(res, 400, `Maximum ${quota.maxItems} items allowed per cluster`);
      }

      await sequelize.transaction(async (transaction) => {
        let linkId: number | null = null;
        if (req.body?.linkId !== undefined && req.body?.linkId !== null && req.body?.linkId !== '') {
          const parsed = Number(req.body.linkId);
          if (!Number.isInteger(parsed) || parsed <= 0) {
            throw {code: 400, error: 'Invalid linkId'};
          }
          const catalog = await UsefulLink.findByPk(parsed, {transaction});
          if (!catalog || !catalog.isCatalog) {
            throw {code: 400, error: 'Catalog link not found'};
          }
          const dup = await UsefulLinkClusterItem.findOne({
            where: {clusterId: cluster.id, linkId: catalog.id},
            transaction,
          });
          if (dup) throw {code: 400, error: 'Link is already in this cluster'};
          linkId = catalog.id;
        } else {
          const title = parseTitle(req.body?.title);
          if (!title.ok) throw {code: 400, error: title.error};
          const url = parseHttpUrl(req.body?.url);
          if (!url.ok) throw {code: 400, error: url.error};
          const descriptionRaw = req.body?.description;
          const description =
            descriptionRaw === undefined
              ? null
              : typeof descriptionRaw === 'string'
                ? descriptionRaw.trim() || null
                : null;
          const tagIds = parseTagIds(req.body?.tagIds);
          if (!tagIds.ok) throw {code: 400, error: tagIds.error};
          const created = await UsefulLink.create(
            {
              title: title.value,
              url: url.value,
              description,
              isPublished: true,
              isCatalog: false,
              ownerId: req.user!.id,
              sortWeight: 0,
            },
            {transaction},
          );
          await upsertEnglishLocale(created, transaction);
          if (tagIds.value?.length) {
            await replaceLinkTags(created.id, tagIds.value, transaction);
          }
          linkId = created.id;
        }

        const maxSort = (await UsefulLinkClusterItem.max('sortOrder', {
          where: {clusterId: cluster.id},
          transaction,
        })) as number | null;
        await UsefulLinkClusterItem.create(
          {
            clusterId: cluster.id,
            linkId,
            sortOrder: (maxSort ?? -1) + 1,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          {transaction},
        );
        await syncClusterLocaleDefaults(cluster.id, transaction);
      });

      await invalidatePublicClusterCaches(cluster);
      return res.status(201).json(await loadSerializedCluster(cluster, {includeItems: true}));
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error) {
        const typed = error as {code: number; error: string};
        return deny(res, typed.code, typed.error);
      }
      if (error instanceof Error && error.message === 'Tag not found') {
        return deny(res, 400, error.message);
      }
      return respondMysqlClientError(res, error, 'Failed to add cluster item', {
        logLabel: 'Add useful link cluster item failed:',
      });
    }
  },
);

router.put(
  '/:id/items/sort-orders',
  Auth.user(),
  ApiDoc({
    operationId: 'putUsefulLinkClusterItemSortOrders',
    summary: 'Reorder cluster items',
    tags: ['Misc', 'Useful Links'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Reordered'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const cluster = await resolveCluster(req.params.id);
      if (!cluster) return deny(res, 404, 'Cluster not found');
      if (!canEditCluster(cluster, req.user, hasFlag, permissionFlags.SUPER_ADMIN)) {
        return deny(res, 403, 'Access denied');
      }
      const sortOrders = parseSortOrders(req.body?.sortOrders);
      if (!Array.isArray(req.body?.sortOrders)) {
        return deny(res, 400, 'Invalid sort orders format');
      }
      await sequelize.transaction(async (transaction) => {
        for (const item of sortOrders) {
          const [affected] = await UsefulLinkClusterItem.update(
            {sortOrder: item.sortOrder},
            {where: {id: item.id, clusterId: cluster.id}, transaction},
          );
          if (affected === 0) {
            throw new Error(`Item with ID ${item.id} not found`);
          }
        }
      });
      await invalidatePublicClusterCaches(cluster);
      return res.json(await loadSerializedCluster(cluster, {includeItems: true}));
    } catch (error) {
      if (error instanceof Error && /not found/.test(error.message)) {
        return deny(res, 400, error.message);
      }
      return respondMysqlClientError(res, error, 'Failed to reorder cluster items', {
        logLabel: 'Reorder useful link cluster items failed:',
      });
    }
  },
);

router.delete(
  '/:id/items/:itemId([0-9]{1,20})',
  Auth.user(),
  ApiDoc({
    operationId: 'deleteUsefulLinkClusterItem',
    summary: 'Remove an item from a cluster',
    tags: ['Misc', 'Useful Links'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Removed'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const cluster = await resolveCluster(req.params.id);
      if (!cluster) return deny(res, 404, 'Cluster not found');
      if (!canEditCluster(cluster, req.user, hasFlag, permissionFlags.SUPER_ADMIN)) {
        return deny(res, 403, 'Access denied');
      }
      const item = await UsefulLinkClusterItem.findOne({
        where: {id: req.params.itemId, clusterId: cluster.id},
      });
      if (!item) return deny(res, 404, 'Item not found');
      const customLinkId = item.linkId;
      await sequelize.transaction(async (transaction) => {
        await item.destroy({transaction});
        if (customLinkId) {
          const link = await UsefulLink.findByPk(customLinkId, {transaction});
          if (link && !link.isCatalog) {
            const remaining = await UsefulLinkClusterItem.count({
              where: {linkId: customLinkId},
              transaction,
            });
            if (remaining === 0) {
              await link.destroy({transaction});
            }
          }
        }
        await syncClusterLocaleDefaults(cluster.id, transaction);
      });
      await invalidatePublicClusterCaches(cluster);
      return res.json(await loadSerializedCluster(cluster, {includeItems: true}));
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to remove cluster item', {
        logLabel: 'Delete useful link cluster item failed:',
      });
    }
  },
);

router.put(
  '/:id/locale-defaults',
  Auth.user(),
  ApiDoc({
    operationId: 'putUsefulLinkClusterLocaleDefault',
    summary: 'Set the default item for a locale in a cluster',
    tags: ['Misc', 'Useful Links'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Default saved'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const cluster = await resolveCluster(req.params.id);
      if (!cluster) return deny(res, 404, 'Cluster not found');
      if (!canEditCluster(cluster, req.user, hasFlag, permissionFlags.SUPER_ADMIN)) {
        return deny(res, 403, 'Access denied');
      }
      const languageCode =
        typeof req.body?.languageCode === 'string'
          ? req.body.languageCode.trim().toLowerCase()
          : '';
      const itemId = Number(req.body?.itemId);
      if (!languageCode || !Number.isInteger(itemId) || itemId <= 0) {
        return deny(res, 400, 'languageCode and itemId are required');
      }
      const items = await loadClusterItems(cluster.id);
      const target = items.find((row) => row.id === itemId);
      if (!target || !target.link?.locales.some((locale) => locale.languageCode === languageCode)) {
        return deny(res, 400, 'Item does not have that locale');
      }
      const existing = await UsefulLinkClusterLocaleDefault.findOne({
        where: {clusterId: cluster.id, languageCode},
      });
      if (existing) {
        await existing.update({itemId});
      } else {
        await UsefulLinkClusterLocaleDefault.create({
          clusterId: cluster.id,
          languageCode,
          itemId,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
      await invalidatePublicClusterCaches(cluster);
      return res.json(await loadSerializedCluster(cluster, {includeItems: true}));
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to set locale default', {
        logLabel: 'Set useful link cluster locale default failed:',
      });
    }
  },
);

router.patch(
  '/:id/items/:itemId([0-9]{1,20})/link',
  Auth.user(),
  ApiDoc({
    operationId: 'patchUsefulLinkClusterCustomLink',
    summary: 'Update a custom (non-catalog) link in a cluster',
    tags: ['Misc', 'Useful Links'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Updated'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const cluster = await resolveCluster(req.params.id);
      if (!cluster) return deny(res, 404, 'Cluster not found');
      if (!canEditCluster(cluster, req.user, hasFlag, permissionFlags.SUPER_ADMIN)) {
        return deny(res, 403, 'Access denied');
      }
      const item = await UsefulLinkClusterItem.findOne({
        where: {id: req.params.itemId, clusterId: cluster.id},
      });
      if (!item?.linkId) return deny(res, 404, 'Item not found');
      const link = await UsefulLink.findByPk(item.linkId);
      if (!link || link.isCatalog) {
        return deny(res, 403, 'Catalog links are edited by administrators');
      }
      if (!isAdmin(req.user) && link.ownerId !== req.user!.id) {
        return deny(res, 403, 'Access denied');
      }
      const updates: Record<string, unknown> = {};
      if (req.body?.title !== undefined) {
        const title = parseTitle(req.body.title);
        if (!title.ok) return deny(res, 400, title.error);
        updates.title = title.value;
      }
      if (req.body?.url !== undefined) {
        const url = parseHttpUrl(req.body.url);
        if (!url.ok) return deny(res, 400, url.error);
        updates.url = url.value;
      }
      if (req.body?.description !== undefined) {
        const description = parseDescription(req.body.description);
        if (!description.ok) return deny(res, 400, description.error);
        updates.description = description.value;
      }
      await sequelize.transaction(async (transaction) => {
        if (Object.keys(updates).length) {
          await link.update(updates, {transaction});
          await upsertEnglishLocale(link, transaction);
        }
        if (req.body?.tagIds !== undefined) {
          const tagIds = parseTagIds(req.body.tagIds);
          if (!tagIds.ok) throw {code: 400, error: tagIds.error};
          await replaceLinkTags(link.id, tagIds.value ?? [], transaction);
        }
        await syncClusterLocaleDefaults(cluster.id, transaction);
      });
      await invalidatePublicClusterCaches(cluster);
      return res.json(await loadSerializedLink(link.id));
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error) {
        const typed = error as {code: number; error: string};
        return deny(res, typed.code, typed.error);
      }
      return respondMysqlClientError(res, error, 'Failed to update custom link', {
        logLabel: 'Update cluster custom link failed:',
      });
    }
  },
);

router.put(
  '/:id/items/:itemId([0-9]{1,20})/locales',
  Auth.user(),
  ApiDoc({
    operationId: 'putUsefulLinkClusterItemLocale',
    summary: 'Add or replace a locale on a custom cluster link',
    tags: ['Misc', 'Useful Links'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Locale saved'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const cluster = await resolveCluster(req.params.id);
      if (!cluster) return deny(res, 404, 'Cluster not found');
      if (!canEditCluster(cluster, req.user, hasFlag, permissionFlags.SUPER_ADMIN)) {
        return deny(res, 403, 'Access denied');
      }
      const parsed = parseLocaleFields(req.body);
      if (!parsed.ok) return deny(res, 400, parsed.error);
      if (!isConfiguredSiteLanguage(parsed.value.languageCode)) {
        return deny(res, 400, 'languageCode is not in the site language list');
      }
      const item = await UsefulLinkClusterItem.findOne({
        where: {id: req.params.itemId, clusterId: cluster.id},
      });
      if (!item?.linkId) return deny(res, 404, 'Item not found');
      const link = await UsefulLink.findByPk(item.linkId);
      if (!link || link.isCatalog) {
        return deny(res, 403, 'Catalog locales are edited by administrators');
      }
      if (!isAdmin(req.user) && link.ownerId !== req.user!.id) {
        return deny(res, 403, 'Access denied');
      }
      await sequelize.transaction(async (transaction) => {
        const existing = await UsefulLinkLocale.findOne({
          where: {linkId: link.id, languageCode: parsed.value.languageCode},
          transaction,
        });
        if (existing) {
          await existing.update(
            {
              title: parsed.value.title,
              url: parsed.value.url,
              description: parsed.value.description,
            },
            {transaction},
          );
        } else {
          await UsefulLinkLocale.create(
            {
              linkId: link.id,
              ...parsed.value,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
            {transaction},
          );
        }
        if (parsed.value.languageCode === DEFAULT_SITE_LANGUAGE) {
          await link.update(
            {
              title: parsed.value.title,
              url: parsed.value.url,
              description: parsed.value.description,
            },
            {transaction},
          );
        }
        await syncClusterLocaleDefaults(cluster.id, transaction);
      });
      await invalidatePublicClusterCaches(cluster);
      return res.json(await loadSerializedCluster(cluster, {includeItems: true}));
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to save item locale', {
        logLabel: 'Save cluster item locale failed:',
      });
    }
  },
);

router.delete(
  '/:id/items/:itemId([0-9]{1,20})/locales/:languageCode',
  Auth.user(),
  ApiDoc({
    operationId: 'deleteUsefulLinkClusterItemLocale',
    summary: 'Remove a locale from a custom cluster link',
    tags: ['Misc', 'Useful Links'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Locale removed'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const cluster = await resolveCluster(req.params.id);
      if (!cluster) return deny(res, 404, 'Cluster not found');
      if (!canEditCluster(cluster, req.user, hasFlag, permissionFlags.SUPER_ADMIN)) {
        return deny(res, 403, 'Access denied');
      }
      const languageCode = String(req.params.languageCode || '').trim().toLowerCase();
      if (languageCode === DEFAULT_SITE_LANGUAGE) {
        return deny(res, 400, 'The default locale cannot be removed');
      }
      const item = await UsefulLinkClusterItem.findOne({
        where: {id: req.params.itemId, clusterId: cluster.id},
      });
      if (!item?.linkId) return deny(res, 404, 'Item not found');
      const link = await UsefulLink.findByPk(item.linkId);
      if (!link || link.isCatalog) {
        return deny(res, 403, 'Catalog locales are edited by administrators');
      }
      const locale = await UsefulLinkLocale.findOne({
        where: {linkId: link.id, languageCode},
      });
      if (!locale) return deny(res, 404, 'Locale not found');
      await locale.destroy();
      await syncClusterLocaleDefaults(cluster.id);
      await invalidatePublicClusterCaches(cluster);
      return res.json(await loadSerializedCluster(cluster, {includeItems: true}));
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to delete item locale', {
        logLabel: 'Delete cluster item locale failed:',
      });
    }
  },
);

export default router;
