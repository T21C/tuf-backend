import { Router, Request, Response } from 'express';
import { Op } from 'sequelize';
import Level from '@/models/levels/Level.js';
import LevelTag from '@/models/levels/LevelTag.js';
import LevelTagGroup from '@/models/levels/LevelTagGroup.js';
import LevelTagAssignment from '@/models/levels/LevelTagAssignment.js';
import { Auth } from '@/server/middleware/auth.js';
import { ApiDoc } from '@/server/middleware/apiDoc.js';
import {
  standardErrorResponses,
  standardErrorResponses400500,
  standardErrorResponses404500,
  standardErrorResponses500,
  idParamSpec,
} from '@/server/schemas/v2/database/index.js';
import sequelize from '@/config/db.js';
import { safeTransactionRollback, getFileIdFromCdnUrl, isCdnUrl } from '@/misc/utils/Utility.js';
import cdnService from '@/server/services/core/CdnService.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { sendCdnErrorResponse, tagIconUpload, updateDifficultiesHash } from './shared.js';
import {
  TAG_GROUP_INCLUDE,
  TAG_LIST_ORDER,
  findOrCreateTagGroupByName,
  loadSerializedTag,
  loadSerializedAssignedTags,
  resolveTagGroupId,
  serializeLevelTags,
} from '@/server/services/data/levelTagGroupService.js';
import {
  applyStaffTagSelection,
  pinCommunityAssignmentsForTag,
  rematerializeCommunityTagsForTagIds,
} from '@/server/services/data/communityTagVoteService.js';
import { parseCommunityTagKnobFields } from '@/misc/utils/data/communityTagEligibility.js';

/**
 * Level tag CRUD + first-class tag groups + level➔tag assignments.
 *
 * Groups live in `level_tag_groups`. Tags reference them via nullable `groupId`
 * (null = ungrouped). API responses still flatten `group` / `groupSortOrder`
 * from the related group so existing clients keep grouping correctly.
 *
 * Note: `/tags/sort-orders`, `/tags/group-sort-orders`, and `/tags/groups`
 * are registered before `/tags/:id([0-9]{1,20})`.
 */

const HEX_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;

const router: Router = Router();

function isResolveGroupError(error: unknown): error is Error {
  return error instanceof Error && (
    error.message === 'Invalid groupId' || error.message === 'Tag group not found'
  );
}

function parseFormBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === true || value === false) return value;
  const s = String(value).trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'on' || s === 'yes') return true;
  if (s === 'false' || s === '0' || s === 'off' || s === 'no') return false;
  return undefined;
}

router.put(
  '/tags/sort-orders',
  Auth.superAdminPassword(),
  ApiDoc({
    operationId: 'putTagSortOrders',
    summary: 'Update tag sort orders',
    description: 'Bulk update tag sort orders. Body: sortOrders[{ id, sortOrder }]. Super admin password.',
    tags: ['Database', 'Difficulties'],
    security: ['bearerAuth'],
    requestBody: { description: 'sortOrders', schema: { type: 'object', properties: { sortOrders: { type: 'array', items: { type: 'object', properties: { id: { type: 'number' }, sortOrder: { type: 'number' } } } } }, required: ['sortOrders'] }, required: true },
    responses: { 200: { description: 'Tag sort orders updated' }, ...standardErrorResponses400500 },
  }),
  async (req: Request, res: Response) => {
    let transaction: any;
    try {
      transaction = await sequelize.transaction();
      const { sortOrders } = req.body;

      if (!Array.isArray(sortOrders)) {
        await safeTransactionRollback(transaction);
        return res.status(400).json({ error: 'Invalid sort orders format' });
      }

      await Promise.all(
        sortOrders.map(async (item) => {
          const { id, sortOrder } = item;
          if (id === undefined || sortOrder === undefined) {
            throw new Error('Missing id or sortOrder in sort orders array');
          }

          const tag = await LevelTag.findByPk(id);
          if (!tag) {
            throw new Error(`Tag with ID ${id} not found`);
          }

          await tag.update({ sortOrder }, { transaction });
        }),
      );

      await transaction.commit();

      await updateDifficultiesHash();

      return res.json({ message: 'Tag sort orders updated successfully' });
    } catch (error) {
      await safeTransactionRollback(transaction);
      logger.error('Error updating tag sort orders:', error);
      return res.status(500).json({
        error: 'Failed to update tag sort orders',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

router.put(
  '/tags/group-sort-orders',
  Auth.superAdminPassword(),
  ApiDoc({
    operationId: 'putTagGroupSortOrders',
    summary: 'Update tag group sort orders',
    description: 'Bulk update tag group sort orders. Body: groups[{ id?, name?, sortOrder }]. Super admin password.',
    tags: ['Database', 'Difficulties'],
    security: ['bearerAuth'],
    requestBody: { description: 'groups', schema: { type: 'object', properties: { groups: { type: 'array', items: { type: 'object', properties: { id: { type: 'number' }, name: { type: 'string' }, sortOrder: { type: 'number' } } } } }, required: ['groups'] }, required: true },
    responses: { 200: { description: 'Group sort orders updated' }, ...standardErrorResponses400500 },
  }),
  async (req: Request, res: Response) => {
    let transaction: any;
    try {
      transaction = await sequelize.transaction();
      const { groups } = req.body;

      if (!Array.isArray(groups)) {
        await safeTransactionRollback(transaction);
        return res.status(400).json({ error: 'Invalid groups format' });
      }

      await Promise.all(
        groups.map(async (item) => {
          const { id, name, sortOrder } = item;
          if (sortOrder === undefined) {
            throw new Error('Missing sortOrder in groups array');
          }
          // Ungrouped is not a row; skip empty names without an id.
          if (id === undefined && (name === undefined || name === '' || name === null)) {
            return;
          }

          const where = id !== undefined ? { id } : { name };
          const [affected] = await LevelTagGroup.update(
            { sortOrder },
            { where, transaction },
          );
          if (affected === 0) {
            throw new Error(
              id !== undefined
                ? `Tag group with ID ${id} not found`
                : `Tag group "${name}" not found`,
            );
          }
        }),
      );

      await transaction.commit();

      await updateDifficultiesHash();

      return res.json({ message: 'Group sort orders updated successfully' });
    } catch (error) {
      await safeTransactionRollback(transaction);
      logger.error('Error updating group sort orders:', error);
      return res.status(500).json({
        error: 'Failed to update group sort orders',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

router.get(
  '/tags/groups',
  ApiDoc({
    operationId: 'getDifficultyTagGroups',
    summary: 'List tag groups',
    description: 'Get all named level tag groups (ordered by sort order). Ungrouped is not a row.',
    tags: ['Database', 'Difficulties'],
    responses: { 200: { description: 'Tag groups list' }, ...standardErrorResponses500 },
  }),
  async (_req: Request, res: Response) => {
    try {
      const groups = await LevelTagGroup.findAll({
        order: [['sortOrder', 'ASC'], ['name', 'ASC']],
      });
      res.json(groups);
    } catch (error) {
      logger.error('Error fetching tag groups:', error);
      res.status(500).json({ error: 'Failed to fetch tag groups' });
    }
  },
);

router.post(
  '/tags/groups',
  Auth.superAdminPassword(),
  ApiDoc({
    operationId: 'postDifficultyTagGroup',
    summary: 'Create tag group',
    description: 'Create a named tag group. Body: name. Super admin password.',
    tags: ['Database', 'Difficulties'],
    security: ['bearerAuth'],
    requestBody: { description: 'name', schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }, required: true },
    responses: { 201: { description: 'Tag group created' }, ...standardErrorResponses400500 },
  }),
  async (req: Request, res: Response) => {
    let transaction: any;
    try {
      transaction = await sequelize.transaction();
      const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
      if (!name) {
        await safeTransactionRollback(transaction);
        return res.status(400).json({ error: 'Group name is required' });
      }

      const existing = await LevelTagGroup.findOne({ where: { name }, transaction });
      if (existing) {
        await safeTransactionRollback(transaction);
        return res.status(400).json({ error: 'A tag group with this name already exists' });
      }

      const group = await findOrCreateTagGroupByName(name, transaction);
      await transaction.commit();
      await updateDifficultiesHash();
      return res.status(201).json(group);
    } catch (error) {
      await safeTransactionRollback(transaction);
      logger.error('Error creating tag group:', error);
      return res.status(500).json({ error: 'Failed to create tag group' });
    }
  },
);

router.put(
  '/tags/groups/:id([0-9]{1,20})',
  Auth.superAdminPassword(),
  ApiDoc({
    operationId: 'putDifficultyTagGroup',
    summary: 'Update tag group',
    description: 'Rename a tag group. Body: name. Super admin password.',
    tags: ['Database', 'Difficulties'],
    security: ['bearerAuth'],
    params: { id: idParamSpec },
    requestBody: { description: 'name', schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }, required: true },
    responses: { 200: { description: 'Tag group updated' }, ...standardErrorResponses },
  }),
  async (req: Request, res: Response) => {
    let transaction: any;
    try {
      transaction = await sequelize.transaction();
      const groupId = parseInt(req.params.id);
      const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
      if (!name) {
        await safeTransactionRollback(transaction);
        return res.status(400).json({ error: 'Group name is required' });
      }

      const group = await LevelTagGroup.findByPk(groupId, { transaction });
      if (!group) {
        await safeTransactionRollback(transaction);
        return res.status(404).json({ error: 'Tag group not found' });
      }

      if (name !== group.name) {
        const existing = await LevelTagGroup.findOne({ where: { name }, transaction });
        if (existing) {
          await safeTransactionRollback(transaction);
          return res.status(400).json({ error: 'A tag group with this name already exists' });
        }
      }

      let knobs: ReturnType<typeof parseCommunityTagKnobFields> = {};
      try {
        knobs = parseCommunityTagKnobFields(req.body as Record<string, unknown>, {
          includeDescription: false,
        });
      } catch (parseError) {
        await safeTransactionRollback(transaction);
        return res.status(400).json({
          error: parseError instanceof Error ? parseError.message : 'Invalid scoring settings',
        });
      }

      await group.update({ name, ...knobs, updatedAt: new Date() }, { transaction });

      const knobKeys = ['wilsonZ', 'scoreOn', 'scoreOff', 'scoringMode', 'allowedBands'] as const;
      const knobsChanged = knobKeys.some((key) => key in knobs);
      if (knobsChanged) {
        const memberTags = await LevelTag.findAll({
          where: { groupId: group.id },
          attributes: ['id'],
          transaction,
        });
        await rematerializeCommunityTagsForTagIds(
          memberTags.map((tag) => tag.id),
          transaction,
          { preserveAssignments: true },
        );
      }

      await transaction.commit();
      await updateDifficultiesHash();
      return res.json(group);
    } catch (error) {
      await safeTransactionRollback(transaction);
      logger.error('Error updating tag group:', error);
      return res.status(500).json({ error: 'Failed to update tag group' });
    }
  },
);

router.delete(
  '/tags/groups/:id([0-9]{1,20})',
  Auth.superAdminPassword(),
  ApiDoc({
    operationId: 'deleteDifficultyTagGroup',
    summary: 'Delete tag group',
    description: 'Delete a tag group. Member tags become ungrouped. Super admin password.',
    tags: ['Database', 'Difficulties'],
    security: ['bearerAuth'],
    params: { id: idParamSpec },
    responses: { 200: { description: 'Tag group deleted' }, ...standardErrorResponses404500 },
  }),
  async (req: Request, res: Response) => {
    let transaction: any;
    try {
      transaction = await sequelize.transaction();
      const groupId = parseInt(req.params.id);
      const group = await LevelTagGroup.findByPk(groupId, { transaction });
      if (!group) {
        await safeTransactionRollback(transaction);
        return res.status(404).json({ error: 'Tag group not found' });
      }

      await group.destroy({ transaction });
      await transaction.commit();
      await updateDifficultiesHash();
      return res.json({ message: 'Tag group deleted successfully' });
    } catch (error) {
      await safeTransactionRollback(transaction);
      logger.error('Error deleting tag group:', error);
      return res.status(500).json({ error: 'Failed to delete tag group' });
    }
  },
);

router.get(
  '/tags',
  ApiDoc({
    operationId: 'getDifficultyTags',
    summary: 'List tags',
    description: 'Get all level tags (ordered by group and sort order).',
    tags: ['Database', 'Difficulties'],
    responses: { 200: { description: 'Tags list' }, ...standardErrorResponses500 },
  }),
  async (_req: Request, res: Response) => {
    try {
      const tags = await LevelTag.findAll({
        include: [TAG_GROUP_INCLUDE],
        order: TAG_LIST_ORDER,
      });
      res.json(serializeLevelTags(tags));
    } catch (error) {
      logger.error('Error fetching tags:', error);
      res.status(500).json({ error: 'Failed to fetch tags' });
    }
  },
);

router.post(
  '/tags',
  Auth.superAdminPassword(),
  tagIconUpload.single('icon'),
  ApiDoc({
    operationId: 'postDifficultyTag',
    summary: 'Create tag',
    description: 'Create level tag. Body: name, color, icon?, group?, groupId?. Multipart: icon. Super admin password.',
    tags: ['Database', 'Difficulties'],
    security: ['bearerAuth'],
    requestBody: { description: 'name, color, icon, group, groupId, isCommunity', schema: { type: 'object', properties: { name: { type: 'string' }, color: { type: 'string' }, icon: { type: 'string' }, group: { type: 'string' }, groupId: { type: 'number' }, isCommunity: { type: 'boolean' } }, required: ['name', 'color'] }, required: true },
    responses: { 201: { description: 'Tag created' }, ...standardErrorResponses400500 },
  }),
  async (req: Request, res: Response) => {
    let transaction: any;
    try {
      transaction = await sequelize.transaction();
      const { name, color, icon, group, groupId, isCommunity } = req.body;
      const iconFile = req.file;

      if (!name || !color) {
        await safeTransactionRollback(transaction);
        return res.status(400).json({ error: 'Missing required fields: name and color are required' });
      }

      if (!HEX_COLOR_PATTERN.test(color)) {
        await safeTransactionRollback(transaction);
        return res.status(400).json({ error: 'Invalid color format. Must be a hex color (e.g., #FF5733)' });
      }

      const existingTag = await LevelTag.findOne({ where: { name } });
      if (existingTag) {
        await safeTransactionRollback(transaction);
        return res.status(400).json({ error: 'A tag with this name already exists' });
      }

      let resolvedGroupId: number | null = null;
      try {
        const resolved = await resolveTagGroupId({ group, groupId }, transaction);
        resolvedGroupId = resolved === undefined ? null : resolved;
      } catch (resolveError) {
        await safeTransactionRollback(transaction);
        if (isResolveGroupError(resolveError)) {
          return res.status(400).json({ error: resolveError.message });
        }
        throw resolveError;
      }

      let finalIconUrl: string | null = null;
      if (iconFile) {
        try {
          const uploadResult = await cdnService.uploadTagIcon(
            iconFile.buffer,
            iconFile.originalname,
          );
          finalIconUrl = uploadResult.urls.original;
        } catch (uploadError) {
          await safeTransactionRollback(transaction);
          return sendCdnErrorResponse(res, uploadError, 'Error uploading tag icon to CDN');
        }
      } else if (icon === 'null' || icon === null) {
        finalIconUrl = null;
      } else if (icon) {
        finalIconUrl = icon;
      }

      let knobs: ReturnType<typeof parseCommunityTagKnobFields> = {};
      try {
        knobs = parseCommunityTagKnobFields(req.body as Record<string, unknown>, {
          includeDescription: true,
        });
      } catch (parseError) {
        await safeTransactionRollback(transaction);
        return res.status(400).json({
          error: parseError instanceof Error ? parseError.message : 'Invalid scoring settings',
        });
      }

      const lastSortOrder = await LevelTag.max('sortOrder') as number || 0;

      const tag = await LevelTag.create({
        name,
        icon: finalIconUrl,
        color,
        groupId: resolvedGroupId,
        sortOrder: lastSortOrder + 1,
        isCommunity: parseFormBoolean(isCommunity) ?? false,
        description: knobs.description ?? null,
        wilsonZ: knobs.wilsonZ ?? null,
        scoreOn: knobs.scoreOn ?? null,
        scoreOff: knobs.scoreOff ?? null,
        scoringMode: knobs.scoringMode ?? null,
        allowedBands: knobs.allowedBands ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }, { transaction });

      await transaction.commit();

      await updateDifficultiesHash();

      const serialized = await loadSerializedTag(tag.id);
      return res.status(201).json(serialized);
    } catch (error) {
      await safeTransactionRollback(transaction);
      logger.error('Error creating tag:', error);
      return res.status(500).json({ error: 'Failed to create tag' });
    }
  },
);

router.put(
  '/tags/:id([0-9]{1,20})',
  Auth.superAdminPassword(),
  tagIconUpload.single('icon'),
  ApiDoc({
    operationId: 'putDifficultyTag',
    summary: 'Update tag',
    description: 'Update level tag. Body: name?, color?, icon?, group?, groupId?. Multipart: icon. Super admin password.',
    tags: ['Database', 'Difficulties'],
    security: ['bearerAuth'],
    params: { id: idParamSpec },
    requestBody: { description: 'name, color, icon, group, groupId', schema: { type: 'object' }, required: true },
    responses: { 200: { description: 'Tag updated' }, ...standardErrorResponses },
  }),
  async (req: Request, res: Response) => {
    let transaction: any;
    try {
      transaction = await sequelize.transaction();
      const tagId = parseInt(req.params.id);
      const { name, color, icon, group, groupId, isCommunity } = req.body;
      const iconFile = req.file;

      const tag = await LevelTag.findByPk(tagId);
      if (!tag) {
        await safeTransactionRollback(transaction);
        return res.status(404).json({ error: 'Tag not found' });
      }

      if (color && !HEX_COLOR_PATTERN.test(color)) {
        await safeTransactionRollback(transaction);
        return res.status(400).json({ error: 'Invalid accent color format. Must be a hex color (e.g., #FF5733)' });
      }

      if (name && name !== tag.name) {
        const existingTag = await LevelTag.findOne({ where: { name } });
        if (existingTag) {
          await safeTransactionRollback(transaction);
          return res.status(400).json({ error: 'A tag with this name already exists' });
        }
      }

      let finalIconUrl: string | null | undefined = undefined;
      let oldFileId: string | null = null;

      if (iconFile) {
        try {
          if (tag.icon && isCdnUrl(tag.icon)) {
            oldFileId = getFileIdFromCdnUrl(tag.icon);
          }

          const uploadResult = await cdnService.uploadTagIcon(
            iconFile.buffer,
            iconFile.originalname,
          );
          finalIconUrl = uploadResult.urls.original;
        } catch (uploadError) {
          await safeTransactionRollback(transaction);
          return sendCdnErrorResponse(res, uploadError, 'Error uploading tag icon to CDN');
        }
      } else if (icon === 'null' || icon === null) {
        if (tag.icon && isCdnUrl(tag.icon)) {
          oldFileId = getFileIdFromCdnUrl(tag.icon);
        }
        finalIconUrl = null;
      }

      let resolvedGroupId: number | null | undefined;
      try {
        resolvedGroupId = await resolveTagGroupId({ group, groupId }, transaction);
      } catch (resolveError) {
        await safeTransactionRollback(transaction);
        if (isResolveGroupError(resolveError)) {
          return res.status(400).json({ error: resolveError.message });
        }
        throw resolveError;
      }

      const updateData: Record<string, unknown> = {
        name: name ?? tag.name,
        icon: finalIconUrl !== undefined ? finalIconUrl : tag.icon,
        color: color ?? tag.color,
        updatedAt: new Date(),
      };

      if (resolvedGroupId !== undefined) {
        updateData.groupId = resolvedGroupId;
      }

      const nextIsCommunity = parseFormBoolean(isCommunity);
      if (nextIsCommunity !== undefined) {
        updateData.isCommunity = nextIsCommunity;
        if (Boolean(tag.isCommunity) !== Boolean(nextIsCommunity)) {
          await pinCommunityAssignmentsForTag(tagId, transaction);
        }
      }

      let knobs: ReturnType<typeof parseCommunityTagKnobFields> = {};
      try {
        knobs = parseCommunityTagKnobFields(req.body as Record<string, unknown>, {
          includeDescription: true,
        });
      } catch (parseError) {
        await safeTransactionRollback(transaction);
        return res.status(400).json({
          error: parseError instanceof Error ? parseError.message : 'Invalid scoring settings',
        });
      }
      Object.assign(updateData, knobs);

      await tag.update(updateData, { transaction });

      const knobKeys = ['wilsonZ', 'scoreOn', 'scoreOff', 'scoringMode', 'allowedBands'] as const;
      if (nextIsCommunity !== undefined || knobKeys.some((key) => key in knobs)) {
        await rematerializeCommunityTagsForTagIds([tagId], transaction, {
          preserveAssignments: true,
        });
      }

      await transaction.commit();

      if (oldFileId && (finalIconUrl !== undefined)) {
        try {
          logger.debug('Cleaning up old tag icon from CDN after tag update', {
            tagId,
            oldFileId,
            newIconUrl: finalIconUrl,
          });
          await cdnService.deleteFile(oldFileId);
          logger.debug('Successfully cleaned up old tag icon from CDN', {
            tagId,
            oldFileId,
          });
        } catch (cleanupError) {
          logger.error('Failed to clean up old tag icon from CDN after tag update:', {
            tagId,
            oldFileId,
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          });
        }
      }

      await updateDifficultiesHash();

      const serialized = await loadSerializedTag(tagId);
      return res.json(serialized);
    } catch (error) {
      await safeTransactionRollback(transaction);
      logger.error('Error updating tag:', error);
      return res.status(500).json({ error: 'Failed to update tag' });
    }
  },
);

router.delete(
  '/tags/:id([0-9]{1,20})',
  Auth.superAdminPassword(),
  ApiDoc({
    operationId: 'deleteDifficultyTag',
    summary: 'Delete tag',
    description: 'Delete level tag and its assignments. Super admin password.',
    tags: ['Database', 'Difficulties'],
    security: ['bearerAuth'],
    params: { id: idParamSpec },
    responses: { 200: { description: 'Tag deleted' }, ...standardErrorResponses404500 },
  }),
  async (req: Request, res: Response) => {
    let transaction: any;
    try {
      transaction = await sequelize.transaction();
      const tagId = parseInt(req.params.id);

      const tag = await LevelTag.findByPk(tagId);
      if (!tag) {
        await safeTransactionRollback(transaction);
        return res.status(404).json({ error: 'Tag not found' });
      }

      const assignments = await LevelTagAssignment.findAll({
        where: { tagId },
        transaction,
      });

      assignments.forEach(async (assignment) => {
        await assignment.destroy({ transaction });
      });

      let fileId: string | null = null;
      if (tag.icon && isCdnUrl(tag.icon)) {
        fileId = getFileIdFromCdnUrl(tag.icon);
      }

      await tag.destroy({ transaction });

      await transaction.commit();

      if (fileId) {
        try {
          logger.debug('Cleaning up tag icon from CDN after tag deletion', {
            tagId,
            fileId,
          });
          await cdnService.deleteFile(fileId);
          logger.debug('Successfully cleaned up tag icon from CDN', {
            tagId,
            fileId,
          });
        } catch (cleanupError) {
          logger.error('Failed to clean up tag icon from CDN after tag deletion:', {
            tagId,
            fileId,
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          });
        }
      }

      await updateDifficultiesHash();

      return res.json({ message: 'Tag deleted successfully' });
    } catch (error) {
      await safeTransactionRollback(transaction);
      logger.error('Error deleting tag:', error);
      return res.status(500).json({ error: 'Failed to delete tag' });
    }
  },
);

router.get(
  '/levels/:levelId([0-9]{1,20})/tags',
  ApiDoc({
    operationId: 'getLevelTags',
    summary: 'Get level tags',
    description: 'Get tags assigned to a level.',
    tags: ['Database', 'Difficulties'],
    params: { levelId: { schema: { type: 'string' } } },
    responses: { 200: { description: 'Tags for level' }, ...standardErrorResponses404500 },
  }),
  async (req: Request, res: Response) => {
    try {
      const levelId = parseInt(req.params.levelId);

      const level = await Level.findByPk(levelId);
      if (!level) {
        return res.status(404).json({ error: 'Level not found' });
      }

      return res.json(await loadSerializedAssignedTags(levelId));
    } catch (error) {
      logger.error('Error fetching level tags:', error);
      return res.status(500).json({ error: 'Failed to fetch level tags' });
    }
  },
);

router.post(
  '/levels/:levelId([0-9]{1,20})/tags',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'postLevelTags',
    summary: 'Assign tags to level',
    description: 'Replace tags assigned to a level. Body: tagIds[]. Super admin.',
    tags: ['Database', 'Difficulties'],
    security: ['bearerAuth'],
    params: { levelId: { schema: { type: 'string' } } },
    requestBody: { description: 'tagIds', schema: { type: 'object', properties: { tagIds: { type: 'array', items: { type: 'number' } } }, required: ['tagIds'] }, required: true },
    responses: { 200: { description: 'Tags assigned' }, ...standardErrorResponses },
  }),
  async (req: Request, res: Response) => {
    let transaction: any;
    try {
      transaction = await sequelize.transaction();
      const levelId = parseInt(req.params.levelId);
      const { tagIds } = req.body;

      if (!Array.isArray(tagIds)) {
        await safeTransactionRollback(transaction);
        return res.status(400).json({ error: 'tagIds must be an array' });
      }

      const level = await Level.findByPk(levelId, { transaction });
      if (!level) {
        await safeTransactionRollback(transaction);
        return res.status(404).json({ error: 'Level not found' });
      }

      try {
        await applyStaffTagSelection(levelId, tagIds, transaction);
      } catch (assignError) {
        await safeTransactionRollback(transaction);
        if (assignError instanceof Error && assignError.message === 'INVALID_TAG_IDS') {
          return res.status(400).json({ error: 'One or more tag IDs are invalid' });
        }
        throw assignError;
      }

      await transaction.commit();

      return res.json(await loadSerializedAssignedTags(levelId));
    } catch (error) {
      await safeTransactionRollback(transaction);
      logger.error('Error assigning tags to level:', error);
      return res.status(500).json({ error: 'Failed to assign tags to level' });
    }
  },
);

export default router;
