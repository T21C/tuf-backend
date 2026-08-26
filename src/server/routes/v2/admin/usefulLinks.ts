import {Router, Request, Response} from 'express';
import {Auth} from '@/server/middleware/auth.js';
import {ApiDoc} from '@/server/middleware/apiDoc.js';
import {getSequelizeForModelGroup} from '@/config/db.js';
import UsefulLink from '@/models/misc/UsefulLink.js';
import UsefulLinkGroup from '@/models/misc/UsefulLinkGroup.js';
import {respondMysqlClientError} from '@/misc/utils/db/mysqlClientError.js';
import {
  parseGroupName,
  parseSortOrders,
  parseUsefulLinkCreate,
  parseUsefulLinkPatch,
} from '@/server/services/usefulLinks/usefulLinkFields.js';
import {
  findOrCreateLinkGroupByName,
  listSerializedLinks,
  loadSerializedLink,
  resolveLinkGroupId,
  serializeUsefulLinkGroup,
} from '@/server/services/usefulLinks/usefulLinkGroupService.js';

const router: Router = Router();
const sequelize = getSequelizeForModelGroup('admin');

function isResolveGroupError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    (error.message === 'Invalid groupId' || error.message === 'Link group not found')
  );
}

/**
 * Groups and sort-order routes are registered before `/:id([0-9]{1,20})`.
 */
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
      return res.json(await listSerializedLinks());
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
  '/group-sort-orders',
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
          const [affected] = await UsefulLinkGroup.update(
            {sortOrder},
            {where, transaction},
          );
          if (affected === 0) {
            throw new Error(
              id !== undefined
                ? `Link group with ID ${id} not found`
                : `Link group "${name}" not found`,
            );
          }
        }
      });
      return res.json({message: 'Group sort orders updated successfully'});
    } catch (error) {
      if (error instanceof Error && /not found|Missing sortOrder/.test(error.message)) {
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
    responses: {200: {description: 'Named groups ordered by sort order'}},
  }),
  async (_req: Request, res: Response) => {
    try {
      const groups = await UsefulLinkGroup.findAll({
        order: [
          ['sortOrder', 'ASC'],
          ['name', 'ASC'],
        ],
      });
      return res.json(groups.map(serializeUsefulLinkGroup));
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
      const group = await findOrCreateLinkGroupByName(parsed.value);
      return res.status(201).json(serializeUsefulLinkGroup(group));
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
      return res.json(serializeUsefulLinkGroup(group));
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
      await group.destroy();
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
    summary: 'List all useful links',
    tags: ['Admin', 'Useful Links'],
    security: ['bearerAuth'],
    responses: {200: {description: 'All links including unpublished'}},
  }),
  async (_req: Request, res: Response) => {
    try {
      return res.json(await listSerializedLinks());
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
      const {group, groupId, ...fields} = parsed.value;
      let resolvedGroupId: number | null = null;
      try {
        const resolved = await resolveLinkGroupId({group, groupId});
        resolvedGroupId = resolved === undefined ? null : resolved;
      } catch (resolveError) {
        if (isResolveGroupError(resolveError)) {
          return res.status(400).json({error: resolveError.message});
        }
        throw resolveError;
      }
      const maxWeight = await UsefulLink.max('sortWeight');
      const sortWeight = (Number(maxWeight) || 0) + 1;
      const link = await UsefulLink.create({
        ...fields,
        groupId: resolvedGroupId,
        sortWeight,
      });
      const serialized = await loadSerializedLink(link.id);
      return res.status(201).json(serialized);
    } catch (error) {
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
      const {group, groupId, ...fields} = parsed.value;
      const updateData: Record<string, unknown> = {...fields};
      try {
        const resolved = await resolveLinkGroupId({group, groupId});
        if (resolved !== undefined) {
          updateData.groupId = resolved;
        }
      } catch (resolveError) {
        if (isResolveGroupError(resolveError)) {
          return res.status(400).json({error: resolveError.message});
        }
        throw resolveError;
      }
      await link.update(updateData);
      const serialized = await loadSerializedLink(link.id);
      return res.json(serialized);
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to update useful link', {
        logLabel: 'Update useful link failed:',
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
      return res.json({success: true});
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to delete useful link', {
        logLabel: 'Delete useful link failed:',
      });
    }
  },
);

export default router;
