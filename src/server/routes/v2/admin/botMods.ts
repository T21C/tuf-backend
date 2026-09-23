import {Router, Request, Response} from 'express';
import {Auth} from '@/server/middleware/auth.js';
import {ApiDoc} from '@/server/middleware/apiDoc.js';
import {respondMysqlClientError} from '@/misc/utils/db/mysqlClientError.js';
import {
  linkBotModToCatalog,
  listBotMods,
  parseBotModId,
  parseBotModListFilter,
  parseBotModListLimit,
  parseBotModListOffset,
  parseCatalogModId,
  runBotModsSync,
  setBotModLinkEnabled,
  setBotModDuplicate,
  unlinkBotMod,
} from '@/server/services/mods/botModSync.js';

const router: Router = Router();

function respondSyncError(res: Response, error: unknown, fallback: string, logLabel: string) {
  const status = (error as Error & {status?: number}).status;
  if (status && status >= 400 && status < 500) {
    return res.status(status).json({error: (error as Error).message});
  }
  return respondMysqlClientError(res, error, fallback, {logLabel});
}

router.get(
  '/',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'adminListBotMods',
    summary: 'List scraped bot mods and their catalog links',
    tags: ['Admin', 'Mods'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Scraped bot mods'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
      const hasModId = req.query.modId !== undefined && String(req.query.modId).trim() !== '';
      const modId = hasModId ? parseCatalogModId(req.query.modId) : undefined;
      if (hasModId && modId === null) {
        return res.status(400).json({error: 'Invalid modId'});
      }
      const result = await listBotMods({
        q: q || undefined,
        filter: parseBotModListFilter(req.query.filter),
        modId: modId ?? undefined,
        offset: parseBotModListOffset(req.query.offset),
        limit: parseBotModListLimit(req.query.limit),
      });
      return res.json(result);
    } catch (error) {
      return respondSyncError(res, error, 'Failed to list bot mods', 'Admin list bot mods failed:');
    }
  },
);

router.post(
  '/sync',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'adminSyncBotMods',
    summary: 'Fetch the bot mods feed and apply linked release updates',
    tags: ['Admin', 'Mods'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Sync result'}},
  }),
  async (_req: Request, res: Response) => {
    try {
      const result = await runBotModsSync();
      return res.json(result);
    } catch (error) {
      return respondSyncError(res, error, 'Failed to sync bot mods', 'Admin sync bot mods failed:');
    }
  },
);

router.put(
  '/:botId/link',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'adminLinkBotMod',
    summary: 'Link a scraped bot mod to a catalog mod',
    tags: ['Admin', 'Mods'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Linked bot mod'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const botId = parseBotModId(req.params.botId);
      if (!botId) return res.status(400).json({error: 'Invalid bot mod id'});
      const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
      const modId = parseCatalogModId(body.modId);
      if (!modId) return res.status(400).json({error: 'modId is required'});
      const botMod = await linkBotModToCatalog(botId, modId);
      return res.json({botMod});
    } catch (error) {
      return respondSyncError(res, error, 'Failed to link bot mod', 'Admin link bot mod failed:');
    }
  },
);

router.patch(
  '/:botId/link',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'adminPatchBotModLink',
    summary: 'Enable or pause a bot mod catalog link',
    tags: ['Admin', 'Mods'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Updated link'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const botId = parseBotModId(req.params.botId);
      if (!botId) return res.status(400).json({error: 'Invalid bot mod id'});
      const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
      if (typeof body.enabled !== 'boolean') {
        return res.status(400).json({error: 'enabled must be a boolean'});
      }
      const botMod = await setBotModLinkEnabled(botId, body.enabled);
      return res.json({botMod});
    } catch (error) {
      return respondSyncError(res, error, 'Failed to update bot mod link', 'Admin patch bot mod link failed:');
    }
  },
);

router.delete(
  '/:botId/link',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'adminUnlinkBotMod',
    summary: 'Remove a bot mod catalog link',
    tags: ['Admin', 'Mods'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Unlinked'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const botId = parseBotModId(req.params.botId);
      if (!botId) return res.status(400).json({error: 'Invalid bot mod id'});
      await unlinkBotMod(botId);
      return res.json({ok: true});
    } catch (error) {
      return respondSyncError(res, error, 'Failed to unlink bot mod', 'Admin unlink bot mod failed:');
    }
  },
);

router.patch(
  '/:botId',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'adminPatchBotMod',
    summary: 'Update scraped bot mod flags',
    tags: ['Admin', 'Mods'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Updated bot mod'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const botId = parseBotModId(req.params.botId);
      if (!botId) return res.status(400).json({error: 'Invalid bot mod id'});
      const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
      if (typeof body.isDuplicate !== 'boolean') {
        return res.status(400).json({error: 'isDuplicate must be a boolean'});
      }
      const botMod = await setBotModDuplicate(botId, body.isDuplicate);
      return res.json({botMod});
    } catch (error) {
      return respondSyncError(res, error, 'Failed to update bot mod', 'Admin patch bot mod failed:');
    }
  },
);

export default router;
