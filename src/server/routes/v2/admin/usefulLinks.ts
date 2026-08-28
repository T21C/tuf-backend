import {Router, Request, Response} from 'express';
import {Auth} from '@/server/middleware/auth.js';
import {ApiDoc} from '@/server/middleware/apiDoc.js';
import {getSequelizeForModelGroup} from '@/config/db.js';
import UsefulLink from '@/models/misc/UsefulLink.js';
import UsefulLinkGroup from '@/models/misc/UsefulLinkGroup.js';
import UsefulLinkLocale from '@/models/misc/UsefulLinkLocale.js';
import {respondMysqlClientError} from '@/misc/utils/db/mysqlClientError.js';
import {
  parseGroupAssignmentSnapshot,
  parseGroupName,
  parseLocaleFields,
  parseSortOrders,
  parseUsefulLinkCreate,
  parseUsefulLinkPatch,
} from '@/server/services/usefulLinks/usefulLinkFields.js';
import {
  applyGroupAssignmentSnapshot,
  assignUngroupedLinksToGroup,
  firstGroup,
  listResourcesCatalog,
  listSerializedGroups,
  loadSerializedLink,
  replaceLinkGroups,
  serializeGroup,
  upsertEnglishLocale,
} from '@/server/services/usefulLinks/usefulLinkGroupService.js';
import {invalidateAllPublicResourceCaches} from '@/server/services/usefulLinks/usefulLinkCache.js';
import {
  DEFAULT_SITE_LANGUAGE,
  isConfiguredSiteLanguage,
} from '@/config/siteLanguages.js';

const router: Router = Router();
const sequelize = getSequelizeForModelGroup('admin');

function isGroupNotFound(error: unknown): boolean {
  return error instanceof Error && error.message === 'Group not found';
}

router.put(
  '/sort-orders',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'adminPutUsefulLinkSortOrders',
    summary: 'Update ungrouped useful link sort orders',
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
      await invalidateAllPublicResourceCaches();
      return res.json(await listResourcesCatalog());
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
  '/group-assignments',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'adminPutUsefulLinkGroupAssignments',
    summary: 'Replace useful link group membership and order',
    tags: ['Admin', 'Useful Links'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Assignments updated'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const parsed = parseGroupAssignmentSnapshot(req.body?.groups);
      if (!parsed.ok) return res.status(400).json({error: parsed.error});
      await sequelize.transaction(async (transaction) => {
        await applyGroupAssignmentSnapshot(parsed.value, transaction);
      });
      await invalidateAllPublicResourceCaches();
      return res.json(await listResourcesCatalog());
    } catch (error) {
      if (isGroupNotFound(error)) {
        return res.status(400).json({error: (error as Error).message});
      }
      return respondMysqlClientError(res, error, 'Failed to update group assignments', {
        logLabel: 'Update useful link group assignments failed:',
      });
    }
  },
);

router.put(
  '/groups/sort-orders',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'adminPutUsefulLinkGroupSortOrders',
    summary: 'Update useful link group sort orders',
    tags: ['Admin', 'Useful Links'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Group sort orders updated'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const sortOrders = parseSortOrders(req.body?.sortOrders ?? req.body?.groups);
      if (!Array.isArray(req.body?.sortOrders) && !Array.isArray(req.body?.groups)) {
        return res.status(400).json({error: 'Invalid sort orders format'});
      }
      await sequelize.transaction(async (transaction) => {
        for (const item of sortOrders) {
          const [affected] = await UsefulLinkGroup.update(
            {sortOrder: item.sortOrder},
            {where: {id: item.id}, transaction},
          );
          if (affected === 0) {
            throw new Error(`Group with ID ${item.id} not found`);
          }
        }
      });
      await invalidateAllPublicResourceCaches();
      return res.json(await listResourcesCatalog());
    } catch (error) {
      if (error instanceof Error && /not found/.test(error.message)) {
        return res.status(400).json({error: error.message});
      }
      return respondMysqlClientError(res, error, 'Failed to update group sort orders', {
        logLabel: 'Update useful link group sort orders failed:',
      });
    }
  },
);

router.get(
  '/groups',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'adminListUsefulLinkGroups',
    summary: 'List useful link groups',
    tags: ['Admin', 'Useful Links'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Groups ordered by sort order'}},
  }),
  async (_req: Request, res: Response) => {
    try {
      const groups = await listSerializedGroups();
      return res.json(groups.map((group) => serializeGroup(group)));
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to list useful link groups', {
        logLabel: 'Admin list useful link groups failed:',
      });
    }
  },
);

router.post(
  '/groups',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'adminCreateUsefulLinkGroup',
    summary: 'Create a useful link group',
    tags: ['Admin', 'Useful Links'],
    security: ['bearerAuth'],
    responses: {201: {description: 'Created'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const parsed = parseGroupName(req.body?.name);
      if (!parsed.ok) {
        return res.status(400).json({error: parsed.error});
      }
      const existing = await UsefulLinkGroup.findOne({where: {name: parsed.value}});
      if (existing) {
        return res.status(400).json({error: 'A group with this name already exists'});
      }
      const group = await sequelize.transaction(async (transaction) => {
        const groupCount = await UsefulLinkGroup.count({transaction});
        const maxSort = (await UsefulLinkGroup.max('sortOrder', {transaction})) as number | null;
        const created = await UsefulLinkGroup.create(
          {
            name: parsed.value,
            sortOrder: (Number(maxSort) || 0) + 1,
          },
          {transaction},
        );
        if (groupCount === 0) {
          await assignUngroupedLinksToGroup(created.id, transaction);
        }
        return created;
      });
      await invalidateAllPublicResourceCaches();
      return res.status(201).json(serializeGroup(group));
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to create useful link group', {
        uniqueMessage: 'A group with this name already exists',
        logLabel: 'Create useful link group failed:',
      });
    }
  },
);

router.put(
  '/groups/:id([0-9]{1,20})',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'adminUpdateUsefulLinkGroup',
    summary: 'Rename a useful link group',
    tags: ['Admin', 'Useful Links'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Updated'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const parsed = parseGroupName(req.body?.name);
      if (!parsed.ok) {
        return res.status(400).json({error: parsed.error});
      }
      const group = await UsefulLinkGroup.findByPk(req.params.id);
      if (!group) return res.status(404).json({error: 'Group not found'});
      if (parsed.value !== group.name) {
        const existing = await UsefulLinkGroup.findOne({where: {name: parsed.value}});
        if (existing) {
          return res.status(400).json({error: 'A group with this name already exists'});
        }
      }
      await group.update({name: parsed.value});
      await invalidateAllPublicResourceCaches();
      return res.json(serializeGroup(group));
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to update useful link group', {
        uniqueMessage: 'A group with this name already exists',
        logLabel: 'Update useful link group failed:',
      });
    }
  },
);

router.delete(
  '/groups/:id([0-9]{1,20})',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'adminDeleteUsefulLinkGroup',
    summary: 'Delete a useful link group',
    tags: ['Admin', 'Useful Links'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Deleted'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const group = await UsefulLinkGroup.findByPk(req.params.id);
      if (!group) return res.status(404).json({error: 'Group not found'});
      await sequelize.transaction(async (transaction) => {
        await group.destroy({transaction});
        const remaining = await firstGroup(transaction);
        if (remaining) {
          await assignUngroupedLinksToGroup(remaining.id, transaction);
        }
      });
      await invalidateAllPublicResourceCaches();
      return res.json({message: 'Group deleted successfully'});
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to delete useful link group', {
        logLabel: 'Delete useful link group failed:',
      });
    }
  },
);

router.get(
  '/',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'adminListUsefulLinks',
    summary: 'List useful links and groups',
    tags: ['Admin', 'Useful Links'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Groups and links'}},
  }),
  async (_req: Request, res: Response) => {
    try {
      return res.json(await listResourcesCatalog());
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
      const {groupIds, ...fields} = parsed.value;
      const maxWeight = await UsefulLink.max('sortWeight');
      const sortWeight = (Number(maxWeight) || 0) + 1;
      const link = await sequelize.transaction(async (transaction) => {
        const created = await UsefulLink.create(
          {
            ...fields,
            sortWeight,
          },
          {transaction},
        );
        await upsertEnglishLocale(created, transaction);
        await replaceLinkGroups(created.id, groupIds ?? [], transaction);
        return created;
      });
      await invalidateAllPublicResourceCaches();
      const serialized = await loadSerializedLink(link.id);
      return res.status(201).json(serialized);
    } catch (error) {
      if (isGroupNotFound(error)) {
        return res.status(400).json({error: (error as Error).message});
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
      const {groupIds, ...fields} = parsed.value;
      await sequelize.transaction(async (transaction) => {
        if (Object.keys(fields).length) {
          await link.update(fields, {transaction});
        }
        if (
          fields.title !== undefined ||
          fields.url !== undefined ||
          fields.description !== undefined ||
          fields.shorthand !== undefined
        ) {
          await upsertEnglishLocale(link, transaction);
        }
        if (groupIds !== undefined) {
          await replaceLinkGroups(link.id, groupIds, transaction);
        }
      });
      await invalidateAllPublicResourceCaches();
      const serialized = await loadSerializedLink(link.id);
      return res.json(serialized);
    } catch (error) {
      if (isGroupNotFound(error)) {
        return res.status(400).json({error: (error as Error).message});
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
              shorthand: parsed.value.shorthand,
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
              shorthand: parsed.value.shorthand,
            },
            {transaction},
          );
        }
      });
      await invalidateAllPublicResourceCaches();
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
      await invalidateAllPublicResourceCaches();
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
      await link.destroy();
      await invalidateAllPublicResourceCaches();
      return res.json({success: true});
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to delete useful link', {
        logLabel: 'Delete useful link failed:',
      });
    }
  },
);

export default router;
