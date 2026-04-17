import { Router } from 'express';
import AnnouncementChannel from '@/models/announcements/AnnouncementChannel.js';
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
 * Announcement-channel CRUD for difficulty auto-pings.
 *
 * All mutation routes are gated behind `Auth.superAdminPassword()` because the
 * configured webhook URLs are plaintext integration secrets. Deletion is a
 * soft-delete (`isActive = false`) so that historical directives retain their
 * referential integrity.
 */

const router: Router = Router();

router.get(
  '/channels',
  Auth.superAdminPassword(),
  ApiDoc({
    operationId: 'getDifficultyChannels',
    summary: 'List channels',
    description: 'List announcement channels. Super admin password.',
    tags: ['Database', 'Difficulties'],
    security: ['bearerAuth'],
    responses: { 200: { description: 'Channels' }, ...standardErrorResponses500 },
  }),
  async (req, res) => {
    try {
      const channels = await AnnouncementChannel.findAll({
        where: { isActive: true },
        order: [['label', 'ASC']],
      });
      res.json(channels);
    } catch (error) {
      logger.error('Error fetching channels:', error);
      res.status(500).json({ error: 'Failed to fetch channels' });
    }
  },
);

router.post(
  '/channels',
  Auth.superAdminPassword(),
  ApiDoc({
    operationId: 'postDifficultyChannel',
    summary: 'Create channel',
    description: 'Create announcement channel. Body: webhookUrl, label. Super admin password.',
    tags: ['Database', 'Difficulties'],
    security: ['bearerAuth'],
    requestBody: { description: 'webhookUrl, label', schema: { type: 'object', properties: { webhookUrl: { type: 'string' }, label: { type: 'string' } }, required: ['webhookUrl', 'label'] }, required: true },
    responses: { 201: { description: 'Channel created' }, ...standardErrorResponses400500 },
  }),
  async (req, res) => {
    try {
      const { webhookUrl, label } = req.body;

      if (!webhookUrl || !label) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      const channel = await AnnouncementChannel.create({
        webhookUrl,
        label,
        isActive: true,
      });

      return res.status(201).json({ message: 'Channel created successfully', channel });
    } catch (error) {
      logger.error('Error creating channel:', error);
      return res.status(500).json({ error: 'Failed to create channel' });
    }
  },
);

router.put(
  '/channels/:id([0-9]{1,20})',
  Auth.superAdminPassword(),
  ApiDoc({
    operationId: 'putDifficultyChannel',
    summary: 'Update channel',
    description: 'Update announcement channel. Body: webhookUrl, label. Super admin password.',
    tags: ['Database', 'Difficulties'],
    security: ['bearerAuth'],
    params: { id: idParamSpec },
    requestBody: { description: 'webhookUrl, label', schema: { type: 'object', properties: { webhookUrl: { type: 'string' }, label: { type: 'string' } }, required: ['webhookUrl', 'label'] }, required: true },
    responses: { 200: { description: 'Channel updated' }, ...standardErrorResponses },
  }),
  async (req, res) => {
    try {
      const channelId = req.params.id;
      const { webhookUrl, label } = req.body;

      if (!webhookUrl || !label) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      const channel = await AnnouncementChannel.findOne({
        where: {
          id: channelId,
          isActive: true,
        },
      });

      if (!channel) {
        return res.status(404).json({ error: 'Channel not found' });
      }

      await channel.update({
        webhookUrl,
        label,
      });

      return res.json({ message: 'Channel updated successfully', channel });
    } catch (error) {
      logger.error('Error updating channel:', error);
      return res.status(500).json({ error: 'Failed to update channel' });
    }
  },
);

router.delete(
  '/channels/:id([0-9]{1,20})',
  Auth.superAdminPassword(),
  ApiDoc({
    operationId: 'deleteDifficultyChannel',
    summary: 'Delete channel',
    description: 'Soft-delete announcement channel. Super admin password.',
    tags: ['Database', 'Difficulties'],
    security: ['bearerAuth'],
    params: { id: idParamSpec },
    responses: { 200: { description: 'Channel deleted' }, ...standardErrorResponses404500 },
  }),
  async (req, res) => {
    try {
      const channelId = req.params.id;

      const channel = await AnnouncementChannel.findOne({
        where: {
          id: channelId,
          isActive: true,
        },
      });

      if (!channel) {
        return res.status(404).json({ error: 'Channel not found' });
      }

      // Soft-delete keeps historical directives referencing this channel intact.
      await channel.update({ isActive: false });

      return res.json({ message: 'Channel deleted successfully' });
    } catch (error) {
      logger.error('Error deleting channel:', error);
      return res.status(500).json({ error: 'Failed to delete channel' });
    }
  },
);

export default router;
