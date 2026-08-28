import {Router, Request, Response} from 'express';
import {Auth} from '@/server/middleware/auth.js';
import {ApiDoc} from '@/server/middleware/apiDoc.js';
import {getSequelizeForModelGroup} from '@/config/db.js';
import UsefulLink from '@/models/misc/UsefulLink.js';
import UsefulLinkTag from '@/models/misc/UsefulLinkTag.js';
import UsefulLinkTagGroup from '@/models/misc/UsefulLinkTagGroup.js';
import UsefulLinkLocale from '@/models/misc/UsefulLinkLocale.js';
import {respondMysqlClientError} from '@/misc/utils/db/mysqlClientError.js';
import {
  parseHexColor,
  parseLocaleFields,
  parseSortOrders,
  parseTagGroupName,
  parseTagName,
  parseUsefulLinkCreate,
  parseUsefulLinkPatch,
} from '@/server/services/usefulLinks/usefulLinkFields.js';
import {
  listSerializedLinks,
  loadSerializedLink,
  upsertEnglishLocale,
} from '@/server/services/usefulLinks/usefulLinkGroupService.js';
import {
  findOrCreateTagGroupByName,
  listSerializedTags,
  loadSerializedTag,
  replaceLinkTags,
  resolveTagGroupId,
  serializeUsefulLinkTagGroup,
} from '@/server/services/usefulLinks/usefulLinkTagService.js';
import {
  invalidateAllPublicResourceCaches,
  invalidatePublicClustersForLink,
} from '@/server/services/usefulLinks/usefulLinkCache.js';
import {
  DEFAULT_SITE_LANGUAGE,
  isConfiguredSiteLanguage,
} from '@/config/siteLanguages.js';

const router: Router = Router();
const sequelize = getSequelizeForModelGroup('admin');

function isResolveGroupError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    (error.message === 'Invalid groupId' || error.message === 'Tag group not found')
  );
}

router.put(
  '/sort-orders',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'adminPutUsefulLinkSortOrders',
    summary: 'Update useful link sort orders',
    tags: ['Admin', 'Useful Links'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Sort orders updated'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const sortOrders = parseSortOrders(req.body?.sortOrders);
      if (!Array.isArray(req.body?.sortOrders)) {
        return res.status(400).json({error: 'Invalid sort orders format'});
      }
      await sequelize.transaction(async (transaction) => {
        for (const item of sortOrders) {
          const [affected] = await UsefulLink.update(
            {sortWeight: item.sortOrder},
            {where: {id: item.id}, transaction},
          );
          if (affected === 0) {
            throw new Error(`Link with ID ${item.id} not found`);
          }
        }
      });
      return res.json(await listSerializedLinks({catalogOnly: true}));
    } catch (error) {
      if (error instanceof Error && /not found/.test(error.message)) {
        return res.status(400).json({error: error.message});
      }
      return respondMysqlClientError(res, error, 'Failed to update useful link sort orders', {
        logLabel: 'Update useful link sort orders failed:',
      });
    }
  },
);

router.put(
  '/tags/sort-orders',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'adminPutUsefulLinkTagSortOrders',
    summary: 'Update useful link tag sort orders',
    tags: ['Admin', 'Useful Links'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Tag sort orders updated'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const sortOrders = parseSortOrders(req.body?.sortOrders);
      if (!Array.isArray(req.body?.sortOrders)) {
        return res.status(400).json({error: 'Invalid sort orders format'});
      }
      await sequelize.transaction(async (transaction) => {
        for (const item of sortOrders) {
          const [affected] = await UsefulLinkTag.update(
            {sortOrder: item.sortOrder},
            {where: {id: item.id}, transaction},
          );
          if (affected === 0) {
            throw new Error(`Tag with ID ${item.id} not found`);
          }
        }
      });
      await invalidateAllPublicResourceCaches();
      return res.json(await listSerializedTags());
    } catch (error) {
      if (error instanceof Error && /not found/.test(error.message)) {
        return res.status(400).json({error: error.message});
      }
      return respondMysqlClientError(res, error, 'Failed to update tag sort orders', {
        logLabel: 'Update useful link tag sort orders failed:',
      });
    }
  },
);

router.put(
  '/tags/group-sort-orders',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'adminPutUsefulLinkTagGroupSortOrders',
    summary: 'Update useful link tag group sort orders',
    tags: ['Admin', 'Useful Links'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Group sort orders updated'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const {groups} = req.body;
      if (!Array.isArray(groups)) {
        return res.status(400).json({error: 'Invalid groups format'});
      }
      await sequelize.transaction(async (transaction) => {
        for (const item of groups) {
          const {id, name, sortOrder} = item ?? {};
          if (sortOrder === undefined) {
            throw new Error('Missing sortOrder in groups array');
          }
          if (id === undefined && (name === undefined || name === '' || name === null)) {
            continue;
          }
          const where = id !== undefined ? {id} : {name};
          const [affected] = await UsefulLinkTagGroup.update(
            {sortOrder},
            {where, transaction},
          );
          if (affected === 0) {
            throw new Error(
              id !== undefined
                ? `Tag group with ID ${id} not found`
                : `Tag group "${name}" not found`,
            );
          }
        }
      });
      await invalidateAllPublicResourceCaches();
      return res.json({message: 'Group sort orders updated successfully'});
    } catch (error) {
      if (error instanceof Error && /not found|Missing sortOrder/.test(error.message)) {
        return res.status(400).json({error: error.message});
      }
      return respondMysqlClientError(res, error, 'Failed to update tag group sort orders', {
        logLabel: 'Update useful link tag group sort orders failed:',
      });
    }
  },
);

router.get(
  '/tags/groups',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'adminListUsefulLinkTagGroups',
    summary: 'List useful link tag groups',
    tags: ['Admin', 'Useful Links'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Named tag groups ordered by sort order'}},
  }),
  async (_req: Request, res: Response) => {
    try {
      const groups = await UsefulLinkTagGroup.findAll({
        order: [
          ['sortOrder', 'ASC'],
          ['name', 'ASC'],
        ],
      });
      return res.json(groups.map(serializeUsefulLinkTagGroup));
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to list useful link tag groups', {
        logLabel: 'Admin list useful link tag groups failed:',
      });
    }
  },
);

router.post(
  '/tags/groups',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'adminCreateUsefulLinkTagGroup',
    summary: 'Create a useful link tag group',
    tags: ['Admin', 'Useful Links'],
    security: ['bearerAuth'],
    responses: {201: {description: 'Created'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const parsed = parseTagGroupName(req.body?.name);
      if (!parsed.ok) {
        return res.status(400).json({error: parsed.error});
      }
      const existing = await UsefulLinkTagGroup.findOne({where: {name: parsed.value}});
      if (existing) {
        return res.status(400).json({error: 'A group with this name already exists'});
      }
      const group = await findOrCreateTagGroupByName(parsed.value);
      return res.status(201).json(serializeUsefulLinkTagGroup(group));
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to create useful link tag group', {
        uniqueMessage: 'A group with this name already exists',
        logLabel: 'Create useful link tag group failed:',
      });
    }
  },
);

router.put(
  '/tags/groups/:id([0-9]{1,20})',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'adminUpdateUsefulLinkTagGroup',
    summary: 'Rename a useful link tag group',
    tags: ['Admin', 'Useful Links'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Updated'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const parsed = parseTagGroupName(req.body?.name);
      if (!parsed.ok) {
        return res.status(400).json({error: parsed.error});
      }
      const group = await UsefulLinkTagGroup.findByPk(req.params.id);
      if (!group) return res.status(404).json({error: 'Group not found'});
      if (parsed.value !== group.name) {
        const existing = await UsefulLinkTagGroup.findOne({where: {name: parsed.value}});
        if (existing) {
          return res.status(400).json({error: 'A group with this name already exists'});
        }
      }
      await group.update({name: parsed.value});
      await invalidateAllPublicResourceCaches();
      return res.json(serializeUsefulLinkTagGroup(group));
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to update useful link tag group', {
        uniqueMessage: 'A group with this name already exists',
        logLabel: 'Update useful link tag group failed:',
      });
    }
  },
);

router.delete(
  '/tags/groups/:id([0-9]{1,20})',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'adminDeleteUsefulLinkTagGroup',
    summary: 'Delete a useful link tag group',
    tags: ['Admin', 'Useful Links'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Deleted'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const group = await UsefulLinkTagGroup.findByPk(req.params.id);
      if (!group) return res.status(404).json({error: 'Group not found'});
      await group.destroy();
      await invalidateAllPublicResourceCaches();
      return res.json({message: 'Group deleted successfully'});
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to delete useful link tag group', {
        logLabel: 'Delete useful link tag group failed:',
      });
    }
  },
);

router.get(
  '/tags',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'adminListUsefulLinkTags',
    summary: 'List useful link tags',
    tags: ['Admin', 'Useful Links'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Tags ordered by group then sort order'}},
  }),
  async (_req: Request, res: Response) => {
    try {
      return res.json(await listSerializedTags());
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to list useful link tags', {
        logLabel: 'Admin list useful link tags failed:',
      });
    }
  },
);

router.post(
  '/tags',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'adminCreateUsefulLinkTag',
    summary: 'Create a useful link tag',
    tags: ['Admin', 'Useful Links'],
    security: ['bearerAuth'],
    responses: {201: {description: 'Created'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const name = parseTagName(req.body?.name);
      if (!name.ok) return res.status(400).json({error: name.error});
      const color = parseHexColor(req.body?.color);
      if (!color.ok) return res.status(400).json({error: color.error});
      const existing = await UsefulLinkTag.findOne({where: {name: name.value}});
      if (existing) {
        return res.status(400).json({error: 'A tag with this name already exists'});
      }
      let resolvedGroupId: number | null = null;
      try {
        const resolved = await resolveTagGroupId({
          group: req.body?.group,
          groupId: req.body?.groupId,
        });
        resolvedGroupId = resolved === undefined ? null : resolved;
      } catch (resolveError) {
        if (isResolveGroupError(resolveError)) {
          return res.status(400).json({error: resolveError.message});
        }
        throw resolveError;
      }
      const maxSort = (await UsefulLinkTag.max('sortOrder')) as number | null;
      const tag = await UsefulLinkTag.create({
        name: name.value,
        color: color.value,
        groupId: resolvedGroupId,
        sortOrder: (maxSort ?? 0) + 1,
      });
      const serialized = await loadSerializedTag(tag.id);
      await invalidateAllPublicResourceCaches();
      return res.status(201).json(serialized);
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to create useful link tag', {
        uniqueMessage: 'A tag with this name already exists',
        logLabel: 'Create useful link tag failed:',
      });
    }
  },
);

router.patch(
  '/tags/:id([0-9]{1,20})',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'adminUpdateUsefulLinkTag',
    summary: 'Update a useful link tag',
    tags: ['Admin', 'Useful Links'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Updated'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const tag = await UsefulLinkTag.findByPk(req.params.id);
      if (!tag) return res.status(404).json({error: 'Tag not found'});
      const updates: Record<string, unknown> = {};
      if (req.body?.name !== undefined) {
        const name = parseTagName(req.body.name);
        if (!name.ok) return res.status(400).json({error: name.error});
        updates.name = name.value;
      }
      if (req.body?.color !== undefined) {
        const color = parseHexColor(req.body.color);
        if (!color.ok) return res.status(400).json({error: color.error});
        updates.color = color.value;
      }
      try {
        const resolved = await resolveTagGroupId({
          group: req.body?.group,
          groupId: req.body?.groupId,
        });
        if (resolved !== undefined) updates.groupId = resolved;
      } catch (resolveError) {
        if (isResolveGroupError(resolveError)) {
          return res.status(400).json({error: resolveError.message});
        }
        throw resolveError;
      }
      if (!Object.keys(updates).length) {
        return res.status(400).json({error: 'No fields to update'});
      }
      await tag.update(updates);
      await invalidateAllPublicResourceCaches();
      return res.json(await loadSerializedTag(tag.id));
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to update useful link tag', {
        uniqueMessage: 'A tag with this name already exists',
        logLabel: 'Update useful link tag failed:',
      });
    }
  },
);

router.delete(
  '/tags/:id([0-9]{1,20})',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'adminDeleteUsefulLinkTag',
    summary: 'Delete a useful link tag',
    tags: ['Admin', 'Useful Links'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Deleted'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const tag = await UsefulLinkTag.findByPk(req.params.id);
      if (!tag) return res.status(404).json({error: 'Tag not found'});
      await tag.destroy();
      await invalidateAllPublicResourceCaches();
      return res.json({success: true});
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to delete useful link tag', {
        logLabel: 'Delete useful link tag failed:',
      });
    }
  },
);

router.get(
  '/',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'adminListUsefulLinks',
    summary: 'List all useful links',
    tags: ['Admin', 'Useful Links'],
    security: ['bearerAuth'],
    responses: {200: {description: 'All catalog links including unpublished'}},
  }),
  async (_req: Request, res: Response) => {
    try {
      return res.json(await listSerializedLinks({catalogOnly: true}));
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to list useful links', {
        logLabel: 'Admin list useful links failed:',
      });
    }
  },
);

router.post(
  '/',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'adminCreateUsefulLink',
    summary: 'Create a useful link',
    tags: ['Admin', 'Useful Links'],
    security: ['bearerAuth'],
    responses: {201: {description: 'Created'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const parsed = parseUsefulLinkCreate(req.body);
      if (!parsed.ok) {
        return res.status(400).json({error: parsed.error});
      }
      const {tagIds, ...fields} = parsed.value;
      const maxWeight = await UsefulLink.max('sortWeight');
      const sortWeight = (Number(maxWeight) || 0) + 1;
      const link = await sequelize.transaction(async (transaction) => {
        const created = await UsefulLink.create(
          {
            ...fields,
            isCatalog: true,
            sortWeight,
          },
          {transaction},
        );
        await upsertEnglishLocale(created, transaction);
        if (tagIds?.length) {
          await replaceLinkTags(created.id, tagIds, transaction);
        }
        return created;
      });
      await invalidatePublicClustersForLink(link.id);
      const serialized = await loadSerializedLink(link.id);
      return res.status(201).json(serialized);
    } catch (error) {
      if (error instanceof Error && error.message === 'Tag not found') {
        return res.status(400).json({error: error.message});
      }
      return respondMysqlClientError(res, error, 'Failed to create useful link', {
        logLabel: 'Create useful link failed:',
      });
    }
  },
);

router.patch(
  '/:id([0-9]{1,20})',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'adminUpdateUsefulLink',
    summary: 'Update a useful link',
    tags: ['Admin', 'Useful Links'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Updated'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const parsed = parseUsefulLinkPatch(req.body);
      if (!parsed.ok) {
        return res.status(400).json({error: parsed.error});
      }
      const link = await UsefulLink.findByPk(req.params.id);
      if (!link) return res.status(404).json({error: 'Link not found'});
      const {tagIds, ...fields} = parsed.value;
      await sequelize.transaction(async (transaction) => {
        if (Object.keys(fields).length) {
          await link.update(fields, {transaction});
        }
        if (
          fields.title !== undefined ||
          fields.url !== undefined ||
          fields.description !== undefined
        ) {
          await upsertEnglishLocale(link, transaction);
        }
        if (tagIds !== undefined) {
          await replaceLinkTags(link.id, tagIds, transaction);
        }
      });
      await invalidatePublicClustersForLink(link.id);
      const serialized = await loadSerializedLink(link.id);
      return res.json(serialized);
    } catch (error) {
      if (error instanceof Error && error.message === 'Tag not found') {
        return res.status(400).json({error: error.message});
      }
      return respondMysqlClientError(res, error, 'Failed to update useful link', {
        logLabel: 'Update useful link failed:',
      });
    }
  },
);

router.put(
  '/:id([0-9]{1,20})/locales',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'adminPutUsefulLinkLocale',
    summary: 'Add or replace a locale variant on a useful link',
    tags: ['Admin', 'Useful Links'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Locale saved'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const parsed = parseLocaleFields(req.body);
      if (!parsed.ok) return res.status(400).json({error: parsed.error});
      if (!isConfiguredSiteLanguage(parsed.value.languageCode)) {
        return res.status(400).json({error: 'languageCode is not in the site language list'});
      }
      const link = await UsefulLink.findByPk(req.params.id);
      if (!link) return res.status(404).json({error: 'Link not found'});
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
      });
      await invalidatePublicClustersForLink(link.id);
      return res.json(await loadSerializedLink(link.id));
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to save useful link locale', {
        logLabel: 'Save useful link locale failed:',
      });
    }
  },
);

router.delete(
  '/:id([0-9]{1,20})/locales/:languageCode',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'adminDeleteUsefulLinkLocale',
    summary: 'Remove a locale variant from a useful link',
    tags: ['Admin', 'Useful Links'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Locale removed'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const languageCode = String(req.params.languageCode || '').trim().toLowerCase();
      if (languageCode === DEFAULT_SITE_LANGUAGE) {
        return res.status(400).json({error: 'The default locale cannot be removed'});
      }
      const link = await UsefulLink.findByPk(req.params.id);
      if (!link) return res.status(404).json({error: 'Link not found'});
      const locale = await UsefulLinkLocale.findOne({
        where: {linkId: link.id, languageCode},
      });
      if (!locale) return res.status(404).json({error: 'Locale not found'});
      await locale.destroy();
      await invalidatePublicClustersForLink(link.id);
      return res.json(await loadSerializedLink(link.id));
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to delete useful link locale', {
        logLabel: 'Delete useful link locale failed:',
      });
    }
  },
);

router.delete(
  '/:id([0-9]{1,20})',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'adminDeleteUsefulLink',
    summary: 'Delete a useful link',
    tags: ['Admin', 'Useful Links'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Deleted'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const link = await UsefulLink.findByPk(req.params.id);
      if (!link) return res.status(404).json({error: 'Link not found'});
      const linkId = link.id;
      await link.destroy();
      await invalidatePublicClustersForLink(linkId);
      return res.json({success: true});
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to delete useful link', {
        logLabel: 'Delete useful link failed:',
      });
    }
  },
);

export default router;
