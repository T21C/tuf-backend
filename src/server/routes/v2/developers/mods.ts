import {Router, Request, Response} from 'express';
import {Auth} from '@/server/middleware/auth.js';
import {ApiDoc} from '@/server/middleware/apiDoc.js';
import {requireCsrfForCookieAuth} from '@/server/middleware/csrf.js';
import {respondMysqlClientError} from '@/misc/utils/db/mysqlClientError.js';
import {multerMemoryCdnImage5Mb as upload} from '@/config/multerMemoryUploads.js';
import {parseModAssigneePatch, parseTagIds} from '@/server/services/mods/modFields.js';
import {serializeMod} from '@/server/services/mods/serializeMod.js';
import {invalidatePublicModsCache} from '@/server/services/mods/modCache.js';
import {indexCatalogMod} from '@/server/services/mods/modSearchIndex.js';
import {listAssignedModsForUser, userCanEditMod} from '@/server/services/mods/modAssign.js';
import {replaceModTags} from '@/server/services/mods/modTags.js';
import {
  CdnError,
  clearModIcon,
  replaceModIcon,
  uploadedIconFile,
} from '@/server/services/mods/modIcon.js';
import {respondWithCdnError} from '@/server/services/core/CdnService.js';

const router: Router = Router();

router.get(
  '/',
  Auth.user(),
  ApiDoc({
    operationId: 'developerListMods',
    summary: 'List mods assigned to the current user',
    tags: ['Developers', 'Mods'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Assigned mods'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const userId = (req.user as {id: string}).id;
      const mods = await listAssignedModsForUser(userId);
      return res.json({mods});
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to list assigned mods', {
        logLabel: 'Developer list mods failed:',
      });
    }
  },
);

router.get(
  '/:id([0-9]{1,20})',
  Auth.user(),
  ApiDoc({
    operationId: 'developerGetMod',
    summary: 'Get an assigned mod',
    tags: ['Developers', 'Mods'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Assigned mod'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const userId = (req.user as {id: string}).id;
      const mod = await userCanEditMod(Number(req.params.id), userId);
      if (!mod) return res.status(403).json({error: 'Not allowed to edit this mod'});
      return res.json({mod: await serializeMod(mod, {includeHidden: true})});
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to load assigned mod', {
        logLabel: 'Developer get mod failed:',
      });
    }
  },
);

router.put(
  '/:id([0-9]{1,20})/tags',
  Auth.user(),
  requireCsrfForCookieAuth,
  ApiDoc({
    operationId: 'developerSetModTags',
    summary: 'Replace tags on an assigned mod',
    tags: ['Developers', 'Mods'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Updated'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const userId = (req.user as {id: string}).id;
      const parsed = parseTagIds(req.body?.tagIds);
      if (!parsed.ok) return res.status(400).json({error: parsed.error});
      const mod = await userCanEditMod(Number(req.params.id), userId);
      if (!mod) return res.status(403).json({error: 'Not allowed to edit this mod'});
      await replaceModTags(mod.id, parsed.value);
      await indexCatalogMod(mod.id);
      await invalidatePublicModsCache();
      return res.json({mod: await serializeMod(mod, {includeHidden: true})});
    } catch (error) {
      const status = (error as Error & {status?: number}).status;
      if (status === 400) return res.status(400).json({error: (error as Error).message});
      return respondMysqlClientError(res, error, 'Failed to set assigned mod tags', {
        logLabel: 'Developer set mod tags failed:',
      });
    }
  },
);

router.patch(
  '/:id([0-9]{1,20})',
  Auth.user(),
  requireCsrfForCookieAuth,
  ApiDoc({
    operationId: 'developerUpdateMod',
    summary: 'Update an assigned mod',
    tags: ['Developers', 'Mods'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Updated'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const userId = (req.user as {id: string}).id;
      const parsed = parseModAssigneePatch(req.body);
      if (!parsed.ok) return res.status(400).json({error: parsed.error});
      const mod = await userCanEditMod(Number(req.params.id), userId);
      if (!mod) return res.status(403).json({error: 'Not allowed to edit this mod'});
      await mod.update({
        ...parsed.value,
        postedByUserId: userId,
      });
      await indexCatalogMod(mod.id);
      await invalidatePublicModsCache();
      return res.json({mod: await serializeMod(mod, {includeHidden: true})});
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to update assigned mod', {
        logLabel: 'Developer update mod failed:',
      });
    }
  },
);

router.post(
  '/:id([0-9]{1,20})/icon',
  Auth.user(),
  requireCsrfForCookieAuth,
  upload.single('icon'),
  ApiDoc({
    operationId: 'developerUploadModIcon',
    summary: 'Upload an assigned mod icon',
    tags: ['Developers', 'Mods'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Uploaded'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const userId = (req.user as {id: string}).id;
      const file = uploadedIconFile(req);
      if (!file) return res.status(400).json({error: 'No file uploaded', code: 'NO_FILE'});
      const mod = await userCanEditMod(Number(req.params.id), userId);
      if (!mod) return res.status(403).json({error: 'Not allowed to edit this mod'});
      const serialized = await replaceModIcon({mod, file, postedByUserId: userId});
      return res.json({mod: serialized});
    } catch (error) {
      if (error instanceof CdnError) return respondWithCdnError(res, error);
      return respondMysqlClientError(res, error, 'Failed to upload assigned mod icon', {
        logLabel: 'Developer upload mod icon failed:',
      });
    }
  },
);

router.delete(
  '/:id([0-9]{1,20})/icon',
  Auth.user(),
  requireCsrfForCookieAuth,
  ApiDoc({
    operationId: 'developerDeleteModIcon',
    summary: 'Remove an assigned mod icon',
    tags: ['Developers', 'Mods'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Removed'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const userId = (req.user as {id: string}).id;
      const mod = await userCanEditMod(Number(req.params.id), userId);
      if (!mod) return res.status(403).json({error: 'Not allowed to edit this mod'});
      const serialized = await clearModIcon({mod, postedByUserId: userId});
      return res.json({mod: serialized});
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to delete assigned mod icon', {
        logLabel: 'Developer delete mod icon failed:',
      });
    }
  },
);

export default router;
