import {Router, Request, Response} from 'express';
import {Auth} from '@/server/middleware/auth.js';
import {ApiDoc} from '@/server/middleware/apiDoc.js';
import {respondMysqlClientError} from '@/misc/utils/db/mysqlClientError.js';
import Mod from '@/models/misc/Mod.js';
import {multerMemoryCdnImage5Mb as upload} from '@/config/multerMemoryUploads.js';
import {parseAssignAssigneesBody, parseModCreate, parseModPatch} from '@/server/services/mods/modFields.js';
import {serializeMod} from '@/server/services/mods/serializeMod.js';
import {invalidatePublicModsCache} from '@/server/services/mods/modCache.js';
import {deleteCatalogMod, indexCatalogMod} from '@/server/services/mods/modSearchIndex.js';
import ElasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';
import {
  parseModLimit,
  parseModOffset,
  parseModSearchQ,
  parseModSort,
} from '@/server/services/elasticsearch/search/mods/modSearchQuery.js';
import {assignUserToMods, unassignUserFromMod} from '@/server/services/mods/modAssign.js';
import {
  CdnError,
  clearModIcon,
  deleteStoredModIcon,
  replaceModIcon,
  uploadedIconFile,
} from '@/server/services/mods/modIcon.js';
import {respondWithCdnError} from '@/server/services/core/CdnService.js';

const router: Router = Router();

router.get(
  '/',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'adminListMods',
    summary: 'List all mods including hidden',
    tags: ['Admin', 'Mods'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Mods page including hidden'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const result = await ElasticsearchService.getInstance().searchMods({
        q: parseModSearchQ(req.query.q),
        offset: parseModOffset(req.query.offset),
        limit: parseModLimit(req.query.limit),
        sort: parseModSort(req.query.sort),
        includeHidden: true,
      });
      return res.json(result);
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to list mods', {
        logLabel: 'Admin list mods failed:',
      });
    }
  },
);

router.post(
  '/',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'adminCreateMod',
    summary: 'Create a catalog mod',
    tags: ['Admin', 'Mods'],
    security: ['bearerAuth'],
    responses: {201: {description: 'Created'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const parsed = parseModCreate(req.body);
      if (!parsed.ok) return res.status(400).json({error: parsed.error});
      const created = await Mod.create(parsed.value);
      await indexCatalogMod(created.id);
      await invalidatePublicModsCache();
      return res.status(201).json(await serializeMod(created, {includeHidden: true}));
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to create mod', {
        logLabel: 'Create mod failed:',
      });
    }
  },
);

router.post(
  '/:id([0-9]{1,20})/assignees',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'adminAssignModUser',
    summary: 'Assign a player account to a mod',
    tags: ['Admin', 'Mods'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Assigned'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const parsed = parseAssignAssigneesBody(req.body);
      if (!parsed.ok) return res.status(400).json({error: parsed.error});
      const result = await assignUserToMods({
        modId: Number(req.params.id),
        playerId: parsed.value.playerId,
        applyToSameCreator: parsed.value.applyToSameCreator,
      });
      if (!result.ok) return res.status(result.status).json({error: result.error});
      return res.json({assignedModCount: result.assignedModCount, mods: result.mods});
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to assign user', {
        logLabel: 'Assign mod user failed:',
      });
    }
  },
);

router.delete(
  '/:id([0-9]{1,20})/assignees/:userId',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'adminUnassignModUser',
    summary: 'Remove an assigned user from a mod',
    tags: ['Admin', 'Mods'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Unassigned'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const result = await unassignUserFromMod({
        modId: Number(req.params.id),
        userId: String(req.params.userId),
      });
      if (!result.ok) return res.status(result.status).json({error: result.error});
      return res.json({success: true, mod: result.mod});
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to unassign user', {
        logLabel: 'Unassign mod user failed:',
      });
    }
  },
);

router.post(
  '/:id([0-9]{1,20})/icon',
  Auth.superAdmin(),
  upload.single('icon'),
  ApiDoc({
    operationId: 'adminUploadModIcon',
    summary: 'Upload a catalog mod icon',
    tags: ['Admin', 'Mods'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Uploaded'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const file = uploadedIconFile(req);
      if (!file) return res.status(400).json({error: 'No file uploaded', code: 'NO_FILE'});
      const mod = await Mod.findByPk(req.params.id);
      if (!mod) return res.status(404).json({error: 'Mod not found'});
      const serialized = await replaceModIcon({mod, file});
      return res.json({mod: serialized});
    } catch (error) {
      if (error instanceof CdnError) return respondWithCdnError(res, error);
      return respondMysqlClientError(res, error, 'Failed to upload mod icon', {
        logLabel: 'Admin upload mod icon failed:',
      });
    }
  },
);

router.delete(
  '/:id([0-9]{1,20})/icon',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'adminDeleteModIcon',
    summary: 'Remove a catalog mod icon',
    tags: ['Admin', 'Mods'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Removed'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const mod = await Mod.findByPk(req.params.id);
      if (!mod) return res.status(404).json({error: 'Mod not found'});
      const serialized = await clearModIcon({mod});
      return res.json({mod: serialized});
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to delete mod icon', {
        logLabel: 'Admin delete mod icon failed:',
      });
    }
  },
);

router.patch(
  '/:id([0-9]{1,20})',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'adminUpdateMod',
    summary: 'Update a catalog mod',
    tags: ['Admin', 'Mods'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Updated'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const parsed = parseModPatch(req.body);
      if (!parsed.ok) return res.status(400).json({error: parsed.error});
      const mod = await Mod.findByPk(req.params.id);
      if (!mod) return res.status(404).json({error: 'Mod not found'});
      await mod.update(parsed.value);
      await indexCatalogMod(mod.id);
      await invalidatePublicModsCache();
      return res.json(await serializeMod(mod, {includeHidden: true}));
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to update mod', {
        logLabel: 'Update mod failed:',
      });
    }
  },
);

router.delete(
  '/:id([0-9]{1,20})',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'adminDeleteMod',
    summary: 'Delete a catalog mod',
    tags: ['Admin', 'Mods'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Deleted'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const mod = await Mod.findByPk(req.params.id);
      if (!mod) return res.status(404).json({error: 'Mod not found'});
      const imageUrl = mod.imageUrl;
      await mod.destroy();
      await deleteCatalogMod(mod.id);
      await deleteStoredModIcon(imageUrl);
      await invalidatePublicModsCache();
      return res.json({success: true});
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to delete mod', {
        logLabel: 'Delete mod failed:',
      });
    }
  },
);

export default router;
