import {Router, Request, Response} from 'express';
import {Auth} from '@/server/middleware/auth.js';
import {ApiDoc} from '@/server/middleware/apiDoc.js';
import {respondMysqlClientError} from '@/misc/utils/db/mysqlClientError.js';
import Mod from '@/models/misc/Mod.js';
import {multerMemoryCdnImage5Mb as upload} from '@/config/multerMemoryUploads.js';
import {parseAssignAssigneesBody, parseMergeBody, parseModCreate, parseModPatch, parseModTagBody, parseModVersionBody, parseTagIds} from '@/server/services/mods/modFields.js';
import {serializeMod, serializeModDetail, serializeModVersion} from '@/server/services/mods/serializeMod.js';
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
import {parseFacetQueryString} from '@/misc/utils/search/facetQuery.js';
import {createCatalogMod, applyModSlugChange, createModVersion, updateModVersion, deleteModVersion, syncLatestVersionFromPatch} from '@/server/services/mods/modCreate.js';
import {allocateAvailableModSlug} from '@/server/services/mods/modCatalog.js';
import {listModTags, replaceModTags} from '@/server/services/mods/modTags.js';
import {mergeMods} from '@/server/services/mods/modMerge.js';
import ModTag from '@/models/misc/ModTag.js';
import ModVersion from '@/models/misc/ModVersion.js';

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
      const facetQueryV1 = parseFacetQueryString(
        typeof req.query.facetQuery === 'string' ? req.query.facetQuery : undefined,
      );
      const result = await ElasticsearchService.getInstance().searchMods({
        q: parseModSearchQ(req.query.q),
        offset: parseModOffset(req.query.offset),
        limit: parseModLimit(req.query.limit),
        sort: parseModSort(req.query.sort),
        includeHidden: true,
        facetQueryV1,
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
      const created = await createCatalogMod(parsed.value);
      await indexCatalogMod(created.id);
      await invalidatePublicModsCache();
      return res.status(201).json(await serializeMod(created, {includeHidden: true, includeVersions: true}));
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to create mod', {
        logLabel: 'Create mod failed:',
      });
    }
  },
);

router.get(
  '/tags',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'adminListModTags',
    summary: 'List mod tags',
    tags: ['Admin', 'Mods'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Mod tags'}},
  }),
  async (_req: Request, res: Response) => {
    try {
      return res.json({tags: await listModTags()});
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to list mod tags', {
        logLabel: 'Admin list mod tags failed:',
      });
    }
  },
);

router.post(
  '/tags',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'adminCreateModTag',
    summary: 'Create a mod tag',
    tags: ['Admin', 'Mods'],
    security: ['bearerAuth'],
    responses: {201: {description: 'Created'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const parsed = parseModTagBody(req.body);
      if (!parsed.ok) return res.status(400).json({error: parsed.error});
      const created = await ModTag.create({
        name: parsed.value.name as string,
        color: parsed.value.color || '#8d70ff',
        sortOrder: parsed.value.sortOrder ?? 0,
      });
      return res.status(201).json({tag: created});
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to create mod tag', {
        logLabel: 'Create mod tag failed:',
      });
    }
  },
);

router.patch(
  '/tags/:id([0-9]{1,20})',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'adminUpdateModTag',
    summary: 'Update a mod tag',
    tags: ['Admin', 'Mods'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Updated'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const parsed = parseModTagBody(req.body, {partial: true});
      if (!parsed.ok) return res.status(400).json({error: parsed.error});
      const tag = await ModTag.findByPk(req.params.id);
      if (!tag) return res.status(404).json({error: 'Tag not found'});
      await tag.update(parsed.value);
      await invalidatePublicModsCache();
      return res.json({tag});
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to update mod tag', {
        logLabel: 'Update mod tag failed:',
      });
    }
  },
);

router.delete(
  '/tags/:id([0-9]{1,20})',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'adminDeleteModTag',
    summary: 'Delete a mod tag',
    tags: ['Admin', 'Mods'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Deleted'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const tag = await ModTag.findByPk(req.params.id);
      if (!tag) return res.status(404).json({error: 'Tag not found'});
      await tag.destroy();
      await invalidatePublicModsCache();
      return res.json({success: true});
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to delete mod tag', {
        logLabel: 'Delete mod tag failed:',
      });
    }
  },
);

router.get(
  '/:id([0-9]{1,20})',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'adminGetMod',
    summary: 'Get a catalog mod including versions',
    tags: ['Admin', 'Mods'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Mod'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const mod = await Mod.findByPk(req.params.id);
      if (!mod) return res.status(404).json({error: 'Mod not found'});
      return res.json({mod: await serializeModDetail(mod, {includeHidden: true})});
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to load mod', {
        logLabel: 'Admin get mod failed:',
      });
    }
  },
);

router.post(
  '/:id([0-9]{1,20})/versions',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'adminCreateModVersion',
    summary: 'Add a release to a catalog mod',
    tags: ['Admin', 'Mods'],
    security: ['bearerAuth'],
    responses: {201: {description: 'Created'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const parsed = parseModVersionBody(req.body);
      if (!parsed.ok) return res.status(400).json({error: parsed.error});
      const mod = await Mod.findByPk(req.params.id);
      if (!mod) return res.status(404).json({error: 'Mod not found'});
      const fields = parsed.value as {version: string; downloadUrl: string; notes: string | null; releasedAt: Date};
      const created = await createModVersion({
        modId: mod.id,
        version: fields.version,
        downloadUrl: fields.downloadUrl,
        notes: fields.notes ?? null,
        releasedAt: fields.releasedAt,
      });
      await indexCatalogMod(mod.id);
      await invalidatePublicModsCache();
      return res.status(201).json({
        version: serializeModVersion(created),
        mod: await serializeModDetail(mod, {includeHidden: true}),
      });
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to create mod version', {
        logLabel: 'Create mod version failed:',
      });
    }
  },
);

router.patch(
  '/:id([0-9]{1,20})/versions/:versionId([0-9]{1,20})',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'adminUpdateModVersion',
    summary: 'Update a catalog mod release',
    tags: ['Admin', 'Mods'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Updated'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const parsed = parseModVersionBody(req.body, {partial: true});
      if (!parsed.ok) return res.status(400).json({error: parsed.error});
      const versionRow = await ModVersion.findOne({
        where: {id: req.params.versionId, modId: req.params.id},
      });
      if (!versionRow) return res.status(404).json({error: 'Version not found'});
      const updated = await updateModVersion(versionRow, parsed.value);
      await indexCatalogMod(versionRow.modId);
      await invalidatePublicModsCache();
      const mod = await Mod.findByPk(versionRow.modId);
      return res.json({
        version: serializeModVersion(updated),
        mod: mod ? await serializeModDetail(mod, {includeHidden: true}) : null,
      });
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to update mod version', {
        logLabel: 'Update mod version failed:',
      });
    }
  },
);

router.delete(
  '/:id([0-9]{1,20})/versions/:versionId([0-9]{1,20})',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'adminDeleteModVersion',
    summary: 'Delete a catalog mod release',
    tags: ['Admin', 'Mods'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Deleted'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const versionRow = await ModVersion.findOne({
        where: {id: req.params.versionId, modId: req.params.id},
      });
      if (!versionRow) return res.status(404).json({error: 'Version not found'});
      await deleteModVersion(versionRow);
      await indexCatalogMod(Number(req.params.id));
      await invalidatePublicModsCache();
      const mod = await Mod.findByPk(req.params.id);
      return res.json({
        success: true,
        mod: mod ? await serializeModDetail(mod, {includeHidden: true}) : null,
      });
    } catch (error) {
      const status = (error as Error & {status?: number}).status;
      if (status === 400) return res.status(400).json({error: (error as Error).message});
      return respondMysqlClientError(res, error, 'Failed to delete mod version', {
        logLabel: 'Delete mod version failed:',
      });
    }
  },
);

router.put(
  '/:id([0-9]{1,20})/tags',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'adminSetModTags',
    summary: 'Replace tags on a catalog mod',
    tags: ['Admin', 'Mods'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Updated'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const parsed = parseTagIds(req.body?.tagIds);
      if (!parsed.ok) return res.status(400).json({error: parsed.error});
      const mod = await Mod.findByPk(req.params.id);
      if (!mod) return res.status(404).json({error: 'Mod not found'});
      await replaceModTags(mod.id, parsed.value);
      await indexCatalogMod(mod.id);
      await invalidatePublicModsCache();
      return res.json({mod: await serializeModDetail(mod, {includeHidden: true})});
    } catch (error) {
      const status = (error as Error & {status?: number}).status;
      if (status === 400) return res.status(400).json({error: (error as Error).message});
      return respondMysqlClientError(res, error, 'Failed to set mod tags', {
        logLabel: 'Set mod tags failed:',
      });
    }
  },
);

router.post(
  '/:id([0-9]{1,20})/merge',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'adminMergeMods',
    summary: 'Merge another mod into this one',
    tags: ['Admin', 'Mods'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Merged'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const parsed = parseMergeBody(req.body);
      if (!parsed.ok) return res.status(400).json({error: parsed.error});
      const result = await mergeMods({
        targetId: Number(req.params.id),
        sourceId: parsed.value.sourceModId,
      });
      if (!result.ok) return res.status(result.status).json({error: result.error});
      return res.json({mod: result.mod});
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to merge mods', {
        logLabel: 'Merge mods failed:',
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
      const {slug, version, downloadUrl, sourceUploadedAt, ...rest} = parsed.value;
      if (Object.keys(rest).length) await mod.update(rest);
      if (slug && slug !== mod.slug) {
        const nextSlug = await allocateAvailableModSlug(
          {
            projectUrl: rest.projectUrl ?? mod.projectUrl,
            downloadUrl: downloadUrl ?? mod.downloadUrl,
            name: rest.name ?? mod.name,
            fallbackIndex: mod.id,
          },
          {suggested: slug, excludeModId: mod.id},
        );
        await applyModSlugChange(mod, nextSlug);
      }
      if (version !== undefined || downloadUrl !== undefined || sourceUploadedAt !== undefined) {
        await syncLatestVersionFromPatch(mod, {version, downloadUrl, sourceUploadedAt});
      }
      await mod.reload();
      await indexCatalogMod(mod.id);
      await invalidatePublicModsCache();
      return res.json(await serializeModDetail(mod, {includeHidden: true}));
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
