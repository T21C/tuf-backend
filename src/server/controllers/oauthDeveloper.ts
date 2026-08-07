import { Request, Response } from 'express';
import {
  parseScopeBitsStored,
  V1_GRANTABLE_MASK_STRING,
  OAUTH_SCOPE_FLAGS_WIRE,
} from '@/config/oauthScopes.js';
import { logger } from '@/server/services/core/LoggerService.js';
import {
  OAuthClientError,
  oauthClientService,
} from '@/server/services/oauth/OAuthClientService.js';
import {
  listGrantsForUser,
  revokeGrantById,
} from '@/server/services/oauth/OAuthTokenService.js';
import cdnService, { CdnError } from '@/server/services/core/CdnService.js';
import { isCdnUrl, getFileIdFromCdnUrl } from '@/misc/utils/Utility.js';

function serializeClient(client: Awaited<ReturnType<typeof oauthClientService.create>>) {
  return {
    id: client.id,
    clientId: client.clientId,
    name: client.name,
    description: client.description,
    homepageUrl: client.homepageUrl,
    privacyUrl: client.privacyUrl,
    iconUrl: client.iconUrl ?? null,
    redirectUris: client.redirectUris,
    /** Discord-style permission bitfield (decimal string). */
    allowedScopes: parseScopeBitsStored(client.allowedScopes).toString(),
    singleGrant: client.singleGrant,
    verified: client.verified,
    status: client.status,
    createdAt: client.createdAt,
    updatedAt: client.updatedAt,
    confidentialComingSoon: true,
  };
}

export const oauthDeveloperController = {
  async listMine(req: Request, res: Response) {
    try {
      const userId = (req.user as { id: string }).id;
      const apps = await oauthClientService.listForOwner(userId);
      return res.json({
        apps: apps.map(serializeClient),
        grantableScopeMask: V1_GRANTABLE_MASK_STRING,
        oauthScopeFlags: OAUTH_SCOPE_FLAGS_WIRE,
      });
    } catch (err) {
      logger.error('oauth_dev_list_error', err);
      return res.status(500).json({ error: 'Failed to list apps' });
    }
  },

  async create(req: Request, res: Response) {
    try {
      if (!req.body?.acceptedTos) {
        return res.status(400).json({ error: 'You must accept the developer ToS' });
      }
      const userId = (req.user as { id: string }).id;
      const client = await oauthClientService.create(userId, req.body);
      return res.status(201).json({ app: serializeClient(client) });
    } catch (err) {
      if (err instanceof OAuthClientError) {
        return res.status(err.status).json({ error: err.message, code: err.code });
      }
      logger.error('oauth_dev_create_error', err);
      return res.status(500).json({ error: 'Failed to create app' });
    }
  },

  async getOne(req: Request, res: Response) {
    try {
      const userId = (req.user as { id: string }).id;
      const client = await oauthClientService.findByIdForOwner(req.params.id, userId);
      if (!client) return res.status(404).json({ error: 'Not found' });
      return res.json({ app: serializeClient(client) });
    } catch (err) {
      logger.error('oauth_dev_get_error', err);
      return res.status(500).json({ error: 'Failed to get app' });
    }
  },

  async update(req: Request, res: Response) {
    try {
      const userId = (req.user as { id: string }).id;
      const client = await oauthClientService.findByIdForOwner(req.params.id, userId);
      if (!client) return res.status(404).json({ error: 'Not found' });
      if (client.status === 'frozen') {
        return res.status(403).json({ error: 'App is frozen' });
      }
      const updated = await oauthClientService.update(client, req.body);
      return res.json({ app: serializeClient(updated) });
    } catch (err) {
      if (err instanceof OAuthClientError) {
        return res.status(err.status).json({ error: err.message, code: err.code });
      }
      logger.error('oauth_dev_update_error', err);
      return res.status(500).json({ error: 'Failed to update app' });
    }
  },

  async remove(req: Request, res: Response) {
    try {
      const userId = (req.user as { id: string }).id;
      const client = await oauthClientService.findByIdForOwner(req.params.id, userId);
      if (!client) return res.status(404).json({ error: 'Not found' });
      await oauthClientService.delete(client);
      return res.json({ success: true });
    } catch (err) {
      logger.error('oauth_dev_delete_error', err);
      return res.status(500).json({ error: 'Failed to delete app' });
    }
  },

  async uploadIcon(req: Request, res: Response) {
    try {
      const userId = (req.user as { id: string }).id;
      const client = await oauthClientService.findByIdForOwner(req.params.id, userId);
      if (!client) return res.status(404).json({ error: 'Not found' });
      if (client.status === 'frozen') {
        return res.status(403).json({ error: 'App is frozen' });
      }
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded', code: 'NO_FILE' });
      }

      const result = await cdnService.uploadOAuthClientIcon(
        req.file.buffer,
        req.file.originalname,
      );

      try {
        if (client.iconUrl && isCdnUrl(client.iconUrl)) {
          const oldFileId = getFileIdFromCdnUrl(client.iconUrl);
          if (oldFileId && (await cdnService.checkFileExists(oldFileId))) {
            await cdnService.deleteFile(oldFileId);
          }
        }
      } catch (error) {
        logger.error('Error deleting old oauth client icon from CDN:', error);
      }

      client.iconUrl = result.urls.original;
      await client.save();

      return res.json({
        message: 'Icon uploaded',
        app: serializeClient(client),
        icon: { id: result.fileId, urls: result.urls },
      });
    } catch (err) {
      logger.error('oauth_dev_icon_upload_error', err);
      if (err instanceof CdnError) {
        return res.status(400).json({
          error: err.message,
          code: err.code,
          details: err.details,
        });
      }
      return res.status(500).json({ error: 'Failed to upload icon' });
    }
  },

  async deleteIcon(req: Request, res: Response) {
    try {
      const userId = (req.user as { id: string }).id;
      const client = await oauthClientService.findByIdForOwner(req.params.id, userId);
      if (!client) return res.status(404).json({ error: 'Not found' });
      if (client.status === 'frozen') {
        return res.status(403).json({ error: 'App is frozen' });
      }

      try {
        if (client.iconUrl && isCdnUrl(client.iconUrl)) {
          const oldFileId = getFileIdFromCdnUrl(client.iconUrl);
          if (oldFileId && (await cdnService.checkFileExists(oldFileId))) {
            await cdnService.deleteFile(oldFileId);
          }
        }
      } catch (error) {
        logger.error('Error deleting oauth client icon from CDN:', error);
      }

      client.iconUrl = null;
      await client.save();
      return res.json({ app: serializeClient(client) });
    } catch (err) {
      logger.error('oauth_dev_icon_delete_error', err);
      return res.status(500).json({ error: 'Failed to delete icon' });
    }
  },
};

export const oauthUserGrantsController = {
  async list(req: Request, res: Response) {
    try {
      const userId = (req.user as { id: string }).id;
      const apps = await listGrantsForUser(userId);
      return res.json({ apps });
    } catch (err) {
      logger.error('oauth_grants_list_error', err);
      return res.status(500).json({ error: 'Failed to list authorized apps' });
    }
  },

  async revoke(req: Request, res: Response) {
    try {
      const userId = (req.user as { id: string }).id;
      const ok = await revokeGrantById(req.params.grantId, userId);
      if (!ok) return res.status(404).json({ error: 'Not found' });
      return res.json({ success: true });
    } catch (err) {
      logger.error('oauth_grants_revoke_error', err);
      return res.status(500).json({ error: 'Failed to revoke app' });
    }
  },
};

export const oauthAdminController = {
  async list(req: Request, res: Response) {
    try {
      const limit = Math.min(Number(req.query.limit) || 100, 200);
      const offset = Number(req.query.offset) || 0;
      const q = typeof req.query.q === 'string' ? req.query.q : '';
      const { apps, total } = await oauthClientService.listAllAdmin({ limit, offset, q });
      return res.json({
        apps: apps.map((c) => ({
          ...serializeClient(c),
          ownerUserId: c.ownerUserId,
          ownerUsername: (c as { owner?: { username?: string } }).owner?.username ?? null,
        })),
        total,
        limit,
        offset,
      });
    } catch (err) {
      logger.error('oauth_admin_list_error', err);
      return res.status(500).json({ error: 'Failed to list clients' });
    }
  },

  async remove(req: Request, res: Response) {
    try {
      const client = await oauthClientService.findByPk(req.params.id);
      if (!client) return res.status(404).json({ error: 'Not found' });

      try {
        if (client.iconUrl && isCdnUrl(client.iconUrl)) {
          const oldFileId = getFileIdFromCdnUrl(client.iconUrl);
          if (oldFileId && (await cdnService.checkFileExists(oldFileId))) {
            await cdnService.deleteFile(oldFileId);
          }
        }
      } catch (error) {
        logger.error('Error deleting oauth client icon from CDN (admin):', error);
      }

      await oauthClientService.delete(client);
      return res.json({ success: true });
    } catch (err) {
      logger.error('oauth_admin_delete_error', err);
      return res.status(500).json({ error: 'Failed to delete client' });
    }
  },

  async freeze(req: Request, res: Response) {
    const client = await oauthClientService.setStatus(req.params.id, 'frozen');
    if (!client) return res.status(404).json({ error: 'Not found' });
    return res.json({ app: serializeClient(client) });
  },

  async unfreeze(req: Request, res: Response) {
    const client = await oauthClientService.setStatus(req.params.id, 'active');
    if (!client) return res.status(404).json({ error: 'Not found' });
    return res.json({ app: serializeClient(client) });
  },

  async verify(req: Request, res: Response) {
    const client = await oauthClientService.setVerified(req.params.id, true);
    if (!client) return res.status(404).json({ error: 'Not found' });
    return res.json({ app: serializeClient(client) });
  },

  async unverify(req: Request, res: Response) {
    const client = await oauthClientService.setVerified(req.params.id, false);
    if (!client) return res.status(404).json({ error: 'Not found' });
    return res.json({ app: serializeClient(client) });
  },
};
