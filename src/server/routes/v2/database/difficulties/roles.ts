import { Router } from 'express';
import AnnouncementRole from '@/models/announcements/AnnouncementRole.js';
import { Auth } from '@/server/middleware/auth.js';
import { ApiDoc } from '@/server/middleware/apiDoc.js';
import {
  standardErrorResponses,
  standardErrorResponses400500,
  standardErrorResponses404500,
  standardErrorResponses500,
  idParamSpec,
} from '@/server/schemas/v2/database/index.js';
import { logger } from '@/server/services/core/LoggerService.js';

/**
 * Announcement-role CRUD for difficulty auto-pings.
 *
 * `messageFormat` must contain at least one of the recognized variables
 * (`{count}`, `{difficultyName}`, `{ping}`, `{groupName}`). Rejecting the
 * write here prevents an unformatted placeholder from ever reaching Discord.
 * Deletion is a soft-delete to preserve historical ping context.
 */

const ALLOWED_MESSAGE_VARIABLES = ['{count}', '{difficultyName}', '{ping}', '{groupName}'];
const MAX_MESSAGE_FORMAT_LENGTH = 500;

const router: Router = Router();

router.get(
  '/roles',
  Auth.superAdminPassword(),
  ApiDoc({
    operationId: 'getDifficultyRoles',
    summary: 'List roles',
    description: 'List announcement roles. Super admin password.',
    tags: ['Database', 'Difficulties'],
    security: ['bearerAuth'],
    responses: { 200: { description: 'Roles' }, ...standardErrorResponses500 },
  }),
  async (req, res) => {
    try {
      const roles = await AnnouncementRole.findAll({
        where: { isActive: true },
        order: [['label', 'ASC']],
      });
      res.json(roles);
    } catch (error) {
      logger.error('Error fetching roles:', error);
      res.status(500).json({ error: 'Failed to fetch roles' });
    }
  },
);

router.post(
  '/roles',
  Auth.superAdminPassword(),
  ApiDoc({
    operationId: 'postDifficultyRole',
    summary: 'Create role',
    description: 'Create announcement role. Body: roleId, label, messageFormat?. Super admin password.',
    tags: ['Database', 'Difficulties'],
    security: ['bearerAuth'],
    requestBody: { description: 'roleId, label, messageFormat', schema: { type: 'object', properties: { roleId: { type: 'string' }, label: { type: 'string' }, messageFormat: { type: 'string' } }, required: ['roleId', 'label'] }, required: true },
    responses: { 201: { description: 'Role created' }, ...standardErrorResponses400500 },
  }),
  async (req, res) => {
    try {
      const { roleId, label, messageFormat } = req.body;

      if (!roleId || !label) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      if (messageFormat) {
        if (messageFormat.length > MAX_MESSAGE_FORMAT_LENGTH) {
          return res.status(400).json({ error: `Message format cannot exceed ${MAX_MESSAGE_FORMAT_LENGTH} characters` });
        }
        const hasRequiredVariable = ALLOWED_MESSAGE_VARIABLES.some(v => messageFormat.includes(v));
        if (!hasRequiredVariable) {
          return res.status(400).json({
            error: `Message format must contain at least one of: ${ALLOWED_MESSAGE_VARIABLES.join(', ')}`,
          });
        }
      }

      const role = await AnnouncementRole.create({
        roleId,
        label,
        messageFormat: messageFormat || null,
        isActive: true,
      });

      return res.status(201).json({ message: 'Role created successfully', role });
    } catch (error) {
      logger.error('Error creating role:', error);
      return res.status(500).json({ error: 'Failed to create role' });
    }
  },
);

router.put(
  '/roles/:id([0-9]{1,20})',
  Auth.superAdminPassword(),
  ApiDoc({
    operationId: 'putDifficultyRole',
    summary: 'Update role',
    description: 'Update announcement role. Body: roleId, label, messageFormat?. Super admin password.',
    tags: ['Database', 'Difficulties'],
    security: ['bearerAuth'],
    params: { id: idParamSpec },
    requestBody: { description: 'roleId, label, messageFormat', schema: { type: 'object', properties: { roleId: { type: 'string' }, label: { type: 'string' }, messageFormat: { type: 'string' } }, required: ['roleId', 'label'] }, required: true },
    responses: { 200: { description: 'Role updated' }, ...standardErrorResponses },
  }),
  async (req, res) => {
    try {
      const roleId = req.params.id;
      const { roleId: newRoleId, label, messageFormat } = req.body;

      if (!newRoleId || !label) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      const role = await AnnouncementRole.findOne({
        where: {
          id: roleId,
          isActive: true,
        },
      });

      if (!role) {
        return res.status(404).json({ error: 'Role not found' });
      }

      if (messageFormat !== undefined) {
        if (messageFormat && messageFormat.length > MAX_MESSAGE_FORMAT_LENGTH) {
          return res.status(400).json({ error: `Message format cannot exceed ${MAX_MESSAGE_FORMAT_LENGTH} characters` });
        }
        if (messageFormat) {
          const hasRequiredVariable = ALLOWED_MESSAGE_VARIABLES.some(v => messageFormat.includes(v));
          if (!hasRequiredVariable) {
            return res.status(400).json({
              error: `Message format must contain at least one of: ${ALLOWED_MESSAGE_VARIABLES.join(', ')}`,
            });
          }
        }
      }

      await role.update({
        roleId: newRoleId,
        label,
        messageFormat: messageFormat !== undefined ? (messageFormat || null) : role.messageFormat,
      });

      return res.json({ message: 'Role updated successfully', role });
    } catch (error) {
      logger.error('Error updating role:', error);
      return res.status(500).json({ error: 'Failed to update role' });
    }
  },
);

router.delete(
  '/roles/:id([0-9]{1,20})',
  Auth.superAdminPassword(),
  ApiDoc({
    operationId: 'deleteDifficultyRole',
    summary: 'Delete role',
    description: 'Soft-delete announcement role. Super admin password.',
    tags: ['Database', 'Difficulties'],
    security: ['bearerAuth'],
    params: { id: idParamSpec },
    responses: { 200: { description: 'Role deleted' }, ...standardErrorResponses404500 },
  }),
  async (req, res) => {
    try {
      const roleId = req.params.id;

      const role = await AnnouncementRole.findOne({
        where: {
          id: roleId,
          isActive: true,
        },
      });

      if (!role) {
        return res.status(404).json({ error: 'Role not found' });
      }

      // Soft-delete keeps historical directives that reference this role intact.
      await role.update({ isActive: false });

      return res.json({ message: 'Role deleted successfully' });
    } catch (error) {
      logger.error('Error deleting role:', error);
      return res.status(500).json({ error: 'Failed to delete role' });
    }
  },
);

export default router;
