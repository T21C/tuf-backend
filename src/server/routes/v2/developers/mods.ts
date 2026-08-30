import {Router, Request, Response} from 'express';
import {Auth} from '@/server/middleware/auth.js';
import {ApiDoc} from '@/server/middleware/apiDoc.js';
import {requireCsrfForCookieAuth} from '@/server/middleware/csrf.js';
import {respondMysqlClientError} from '@/misc/utils/db/mysqlClientError.js';
import {multerMemoryCdnImage5Mb as upload} from '@/config/multerMemoryUploads.js';
import {multerModZipSingle, unlinkModZipUpload} from '@/config/multerModZip.js';
import {parseModAssigneePatch, parseModReleaseBody, parseTagIds} from '@/server/services/mods/modFields.js';
import {serializeMod, serializeModDetail, serializeModVersion} from '@/server/services/mods/serializeMod.js';
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
import ModVersion from '@/models/misc/ModVersion.js';
import {
  createReleaseFromParsed,
  removeModRelease,
  updateReleaseFromParsed,
  uploadedReleaseFile,
} from '@/server/services/mods/modRelease.js';

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
      return res.json({mod: await serializeMod(mod, {includeHidden: true, includeVersions: true})});
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

function respondDeveloperReleaseError(res: Response, error: unknown, fallback: string, logLabel: string) {
  const status = (error as Error & {status?: number}).status;
  if (status === 400) return res.status(400).json({error: (error as Error).message});
  if (error instanceof CdnError) return respondWithCdnError(res, error);
  return respondMysqlClientError(res, error, fallback, {logLabel});
}

router.post(
  '/:id([0-9]{1,20})/versions',
  Auth.user(),
  requireCsrfForCookieAuth,
  multerModZipSingle,
  ApiDoc({
    operationId: 'developerCreateModVersion',
    summary: 'Add a release to an assigned mod',
    tags: ['Developers', 'Mods'],
    security: ['bearerAuth'],
    responses: {201: {description: 'Created'}},
  }),
  async (req: Request, res: Response) => {
    const file = uploadedReleaseFile(req);
    try {
      const userId = (req.user as {id: string}).id;
      const parsed = parseModReleaseBody(req.body, {hasFile: Boolean(file)});
      if (!parsed.ok) return res.status(400).json({error: parsed.error});
      const mod = await userCanEditMod(Number(req.params.id), userId);
      if (!mod) return res.status(403).json({error: 'Not allowed to edit this mod'});
      const created = await createReleaseFromParsed(mod.id, parsed.value, file);
      await indexCatalogMod(mod.id);
      await invalidatePublicModsCache();
      return res.status(201).json({
        version: serializeModVersion(created),
        mod: await serializeModDetail(mod, {includeHidden: true}),
      });
    } catch (error) {
      return respondDeveloperReleaseError(res, error, 'Failed to create mod version', 'Developer create mod version failed:');
    } finally {
      unlinkModZipUpload(req.file);
    }
  },
);

router.patch(
  '/:id([0-9]{1,20})/versions/:versionId([0-9]{1,20})',
  Auth.user(),
  requireCsrfForCookieAuth,
  multerModZipSingle,
  ApiDoc({
    operationId: 'developerUpdateModVersion',
    summary: 'Update a release on an assigned mod',
    tags: ['Developers', 'Mods'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Updated'}},
  }),
  async (req: Request, res: Response) => {
    const file = uploadedReleaseFile(req);
    try {
      const userId = (req.user as {id: string}).id;
      const parsed = parseModReleaseBody(req.body, {partial: true, hasFile: Boolean(file)});
      if (!parsed.ok) return res.status(400).json({error: parsed.error});
      const mod = await userCanEditMod(Number(req.params.id), userId);
      if (!mod) return res.status(403).json({error: 'Not allowed to edit this mod'});
      const versionRow = await ModVersion.findOne({
        where: {id: req.params.versionId, modId: mod.id},
      });
      if (!versionRow) return res.status(404).json({error: 'Version not found'});
      const updated = await updateReleaseFromParsed(versionRow, parsed.value, file);
      await indexCatalogMod(mod.id);
      await invalidatePublicModsCache();
      return res.json({
        version: serializeModVersion(updated),
        mod: await serializeModDetail(mod, {includeHidden: true}),
      });
    } catch (error) {
      return respondDeveloperReleaseError(res, error, 'Failed to update mod version', 'Developer update mod version failed:');
    } finally {
      unlinkModZipUpload(req.file);
    }
  },
);

router.delete(
  '/:id([0-9]{1,20})/versions/:versionId([0-9]{1,20})',
  Auth.user(),
  requireCsrfForCookieAuth,
  ApiDoc({
    operationId: 'developerDeleteModVersion',
    summary: 'Delete a release on an assigned mod',
    tags: ['Developers', 'Mods'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Deleted'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const userId = (req.user as {id: string}).id;
      const mod = await userCanEditMod(Number(req.params.id), userId);
      if (!mod) return res.status(403).json({error: 'Not allowed to edit this mod'});
      const versionRow = await ModVersion.findOne({
        where: {id: req.params.versionId, modId: mod.id},
      });
      if (!versionRow) return res.status(404).json({error: 'Version not found'});
      await removeModRelease(versionRow);
      await indexCatalogMod(mod.id);
      await invalidatePublicModsCache();
      return res.json({
        success: true,
        mod: await serializeModDetail(mod, {includeHidden: true}),
      });
    } catch (error) {
      return respondDeveloperReleaseError(res, error, 'Failed to delete mod version', 'Developer delete mod version failed:');
    }
  },
);

export default router;
