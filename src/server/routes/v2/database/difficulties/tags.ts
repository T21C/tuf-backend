import { Router, Request, Response } from 'express';
import { Op } from 'sequelize';
import Level from '@/models/levels/Level.js';
import LevelTag from '@/models/levels/LevelTag.js';
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
import { getIO } from '@/misc/utils/server/socket.js';
import { sseManager } from '@/misc/utils/server/sse.js';
import { safeTransactionRollback, getFileIdFromCdnUrl, isCdnUrl } from '@/misc/utils/Utility.js';
import cdnService, { CdnError } from '@/server/services/core/CdnService.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { tagIconUpload, updateDifficultiesHash } from './shared.js';

/**
 * Level tag CRUD + sort-order management + level→tag assignments.
 *
 * The tag tree is two-tiered: tags are grouped under a named `group`, and both
 * the tags within a group and the groups themselves have their own sort order
 * (`sortOrder` vs `groupSortOrder`). Tags with `group = null | ''` collapse
 * into a shared "Ungrouped" pseudo-group that shares a single `groupSortOrder`.
 *
 * Note: `/tags/sort-orders` and `/tags/group-sort-orders` are registered before
 * `/tags/:id([0-9]{1,20})` so that Express' matcher doesn't greedily try to
 * parse the literal strings `sort-orders`/`group-sort-orders` as numeric IDs.
 * The id regex would fail that match, but keeping the bulk routes first avoids
 * relying on that detail.
 */

const HEX_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;

const router: Router = Router();

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

      const io = getIO();
      io.emit('tagsReordered');

      sseManager.broadcast({
        type: 'tagsReordered',
        data: {
          action: 'reorder',
          count: sortOrders.length,
        },
      });

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
    description: 'Bulk update tag group sort orders. Body: groups[{ name, sortOrder }]. Super admin password.',
    tags: ['Database', 'Difficulties'],
    security: ['bearerAuth'],
    requestBody: { description: 'groups', schema: { type: 'object', properties: { groups: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, sortOrder: { type: 'number' } } } } }, required: ['groups'] }, required: true },
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
          const { name, sortOrder } = item;
          if (name === undefined || sortOrder === undefined) {
            throw new Error('Missing name or sortOrder in groups array');
          }

          // An empty or null name targets the "Ungrouped" bucket, which stores
          // its membership as either `null` or `''` (legacy writes).
          const whereClause = name === '' || name === null
            ? { [Op.or]: [{ group: null }, { group: '' }] }
            : { group: name };

          await LevelTag.update(
            { groupSortOrder: sortOrder },
            { where: whereClause, transaction },
          );
        }),
      );

      await transaction.commit();

      await updateDifficultiesHash();

      const io = getIO();
      io.emit('tagsReordered');

      sseManager.broadcast({
        type: 'tagsReordered',
        data: {
          action: 'groupReorder',
          count: groups.length,
        },
      });

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
  '/tags',
  ApiDoc({
    operationId: 'getDifficultyTags',
    summary: 'List tags',
    description: 'Get all level tags (ordered by group and sort order).',
    tags: ['Database', 'Difficulties'],
    responses: { 200: { description: 'Tags list' }, ...standardErrorResponses500 },
  }),
  async (req: Request, res: Response) => {
    try {
      const tags = await LevelTag.findAll({
        order: [['groupSortOrder', 'ASC'], ['sortOrder', 'ASC'], ['name', 'ASC']],
      });
      res.json(tags);
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
    description: 'Create level tag. Body: name, color, icon?, group?. Multipart: icon. Super admin password.',
    tags: ['Database', 'Difficulties'],
    security: ['bearerAuth'],
    requestBody: { description: 'name, color, icon, group', schema: { type: 'object', properties: { name: { type: 'string' }, color: { type: 'string' }, icon: { type: 'string' }, group: { type: 'string' } }, required: ['name', 'color'] }, required: true },
    responses: { 201: { description: 'Tag created' }, ...standardErrorResponses400500 },
  }),
  async (req: Request, res: Response) => {
    let transaction: any;
    try {
      transaction = await sequelize.transaction();
      const { name, color, icon, group } = req.body;
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

      // Icon resolution priority:
      //   1. Attached file → upload to CDN, return its canonical URL
      //   2. Explicit null (string "null" or literal null) → no icon
      //   3. String URL provided → store verbatim (external or pre-uploaded)
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

          if (uploadError instanceof CdnError) {
            const statusCode = uploadError.code === 'VALIDATION_ERROR' ? 400 : 500;
            const errorResponse: any = {
              error: uploadError.message,
              code: uploadError.code,
            };

            if (uploadError.details) {
              if (uploadError.details.errors) {
                errorResponse.errors = uploadError.details.errors;
              }
              if (uploadError.details.warnings) {
                errorResponse.warnings = uploadError.details.warnings;
              }
              if (uploadError.details.metadata) {
                errorResponse.metadata = uploadError.details.metadata;
              }
            }

            logger.debug('Error uploading tag icon to CDN:', uploadError);
            return res.status(statusCode).json(errorResponse);
          }

          logger.error('Error uploading tag icon to CDN:', uploadError);
          return res.status(500).json({
            error: 'Failed to upload icon to CDN',
            details: uploadError instanceof Error ? uploadError.message : String(uploadError),
          });
        }
      } else if (icon === 'null' || icon === null) {
        finalIconUrl = null;
      } else if (icon) {
        finalIconUrl = icon;
      }

      const lastSortOrder = await LevelTag.max('sortOrder') as number || 0;

      // Group sort order: reuse the existing group's value if the group is
      // known, otherwise allocate max+1. Ungrouped tags share one bucket.
      let groupSortOrder = 0;
      if (group) {
        const existingGroupTag = await LevelTag.findOne({
          where: { group },
          transaction,
        });
        if (existingGroupTag) {
          groupSortOrder = existingGroupTag.groupSortOrder;
        } else {
          const maxGroupSortOrder = await LevelTag.max('groupSortOrder', { transaction }) as number || 0;
          groupSortOrder = maxGroupSortOrder + 1;
        }
      } else {
        const existingUngroupedTag = await LevelTag.findOne({
          where: { [Op.or]: [{ group: null }, { group: '' }] },
          transaction,
        });
        if (existingUngroupedTag) {
          groupSortOrder = existingUngroupedTag.groupSortOrder;
        } else {
          const maxGroupSortOrder = await LevelTag.max('groupSortOrder', { transaction }) as number || 0;
          groupSortOrder = maxGroupSortOrder + 1;
        }
      }

      const tag = await LevelTag.create({
        name,
        icon: finalIconUrl,
        color,
        group: group || null,
        sortOrder: lastSortOrder + 1,
        groupSortOrder,
        createdAt: new Date(),
        updatedAt: new Date(),
      }, { transaction });

      await transaction.commit();

      await updateDifficultiesHash();

      return res.status(201).json(tag);
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
    description: 'Update level tag. Body: name?, color?, icon?, group?. Multipart: icon. Super admin password.',
    tags: ['Database', 'Difficulties'],
    security: ['bearerAuth'],
    params: { id: idParamSpec },
    requestBody: { description: 'name, color, icon, group', schema: { type: 'object' }, required: true },
    responses: { 200: { description: 'Tag updated' }, ...standardErrorResponses },
  }),
  async (req: Request, res: Response) => {
    let transaction: any;
    try {
      transaction = await sequelize.transaction();
      const tagId = parseInt(req.params.id);
      const { name, color, icon, group } = req.body;
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

      // Icon update priority:
      //   1. Attached file → upload new and mark old for cleanup
      //   2. Explicit null → remove icon and mark old for cleanup
      //   3. Anything else → keep current icon (finalIconUrl stays undefined)
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

          if (uploadError instanceof CdnError) {
            const statusCode = uploadError.code === 'VALIDATION_ERROR' ? 400 : 500;
            const errorResponse: any = {
              error: uploadError.message,
              code: uploadError.code,
            };

            if (uploadError.details) {
              if (uploadError.details.errors) {
                errorResponse.errors = uploadError.details.errors;
              }
              if (uploadError.details.warnings) {
                errorResponse.warnings = uploadError.details.warnings;
              }
              if (uploadError.details.metadata) {
                errorResponse.metadata = uploadError.details.metadata;
              }
            }

            logger.error('Error uploading tag icon to CDN:', uploadError);
            return res.status(statusCode).json(errorResponse);
          }

          logger.error('Error uploading tag icon to CDN:', uploadError);
          return res.status(500).json({
            error: 'Failed to upload icon to CDN',
            details: uploadError instanceof Error ? uploadError.message : String(uploadError),
          });
        }
      } else if (icon === 'null' || icon === null) {
        if (tag.icon && isCdnUrl(tag.icon)) {
          oldFileId = getFileIdFromCdnUrl(tag.icon);
        }
        finalIconUrl = null;
      }

      // Recompute groupSortOrder only when the group is actually changing, so
      // a PUT that touches a single unrelated field doesn't accidentally shove
      // the tag into a different row-ordering bucket.
      let groupSortOrder: number | undefined = undefined;
      const newGroup = group !== undefined ? (group || null) : tag.group;
      const isGroupChanging = group !== undefined && newGroup !== tag.group;

      if (isGroupChanging) {
        if (newGroup) {
          const existingGroupTag = await LevelTag.findOne({
            where: { group: newGroup },
            transaction,
          });
          if (existingGroupTag) {
            groupSortOrder = existingGroupTag.groupSortOrder;
          } else {
            const maxGroupSortOrder = await LevelTag.max('groupSortOrder', { transaction }) as number || 0;
            groupSortOrder = maxGroupSortOrder + 1;
          }
        } else {
          const existingUngroupedTag = await LevelTag.findOne({
            where: { [Op.or]: [{ group: null }, { group: '' }] },
            transaction,
          });
          if (existingUngroupedTag) {
            groupSortOrder = existingUngroupedTag.groupSortOrder;
          } else {
            const maxGroupSortOrder = await LevelTag.max('groupSortOrder', { transaction }) as number || 0;
            groupSortOrder = maxGroupSortOrder + 1;
          }
        }
      }

      const updateData: any = {
        name: name ?? tag.name,
        icon: finalIconUrl !== undefined ? finalIconUrl : tag.icon,
        color: color ?? tag.color,
        group: newGroup,
        updatedAt: new Date(),
      };

      if (groupSortOrder !== undefined) {
        updateData.groupSortOrder = groupSortOrder;
      }

      await tag.update(updateData, { transaction });

      await transaction.commit();

      // Clean up the old CDN file only after the transaction commits. A failed
      // cleanup must not roll back the successful tag update.
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

      return res.json(tag);
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

      // CDN cleanup runs post-commit; a failure here must not leak back to
      // the caller, which already observed a successful deletion.
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

      const assignments = await LevelTagAssignment.findAll({
        where: { levelId },
      });

      const assignmentTagIds = assignments.map(a => a.tagId);
      const tags = await LevelTag.findAll({
        where: { id: { [Op.in]: assignmentTagIds } },
        order: [['name', 'ASC']],
      });

      return res.json(tags);
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

      if (tagIds.length > 0) {
        const tags = await LevelTag.findAll({
          where: { id: { [Op.in]: tagIds } },
          transaction,
        });

        if (tags.length !== tagIds.length) {
          await safeTransactionRollback(transaction);
          return res.status(400).json({ error: 'One or more tag IDs are invalid' });
        }
      }

      // Replace-all semantics: destroy existing assignments then bulk-create
      // the new set inside the same transaction.
      await LevelTagAssignment.destroy({
        where: { levelId },
        transaction,
      });

      if (tagIds.length > 0) {
        await LevelTagAssignment.bulkCreate(
          tagIds.map((tagId: number) => ({
            levelId,
            tagId,
            createdAt: new Date(),
            updatedAt: new Date(),
          })),
          { transaction },
        );
      }

      await transaction.commit();

      const assignments = await LevelTagAssignment.findAll({
        where: { levelId },
      });

      const assignmentTagIds = assignments.map(a => a.tagId);
      const updatedTags = await LevelTag.findAll({
        where: { id: { [Op.in]: assignmentTagIds } },
        order: [['name', 'ASC']],
      });

      return res.json(updatedTags);
    } catch (error) {
      await safeTransactionRollback(transaction);
      logger.error('Error assigning tags to level:', error);
      return res.status(500).json({ error: 'Failed to assign tags to level' });
    }
  },
);

export default router;
