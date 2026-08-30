import {Router, Request, Response} from 'express';
import {ApiDoc} from '@/server/middleware/apiDoc.js';
import {Cache} from '@/server/middleware/cache.js';
import {Auth} from '@/server/middleware/auth.js';
import ElasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';
import {respondMysqlClientError} from '@/misc/utils/db/mysqlClientError.js';
import {parseFacetQueryString} from '@/misc/utils/search/facetQuery.js';
import {parseClientIp} from '@/misc/utils/auth/rateLimitSubjects.js';
import {PUBLIC_MODS_CACHE_TAG} from '@/server/services/mods/modCache.js';
import {
  parseModLimit,
  parseModOffset,
  parseModSearchQ,
  parseModSort,
} from '@/server/services/elasticsearch/search/mods/modSearchQuery.js';
import {annotateModsWithLikeState} from '@/server/services/mods/modLikeState.js';
import {listModTags} from '@/server/services/mods/modTags.js';
import {findModBySlug, findModVersion, latestModVersion} from '@/server/services/mods/modCatalog.js';
import {serializeModDetail} from '@/server/services/mods/serializeMod.js';
import {recordUniqueModDownload} from '@/server/services/mods/modDownloads.js';
import {setModLiked} from '@/server/services/mods/modLikes.js';
import ModLike from '@/models/misc/ModLike.js';

const router: Router = Router();

function wantsPersonalizedList(req: Request): boolean {
  return Boolean(req.query.withLikeState) || Boolean(req.query.facetQuery);
}

async function resolvePublicMod(req: Request, res: Response) {
  const slug = decodeURIComponent(String(req.params.slug || ''));
  const resolved = await findModBySlug(slug);
  if (!resolved || resolved.mod.hidden) {
    res.status(404).json({error: 'Mod not found'});
    return null;
  }
  return resolved.mod;
}

router.get(
  '/',
  Auth.addUserToRequest(),
  Cache({
    ttl: 300,
    prefix: 'mods:public',
    tags: [PUBLIC_MODS_CACHE_TAG],
    skipIf: wantsPersonalizedList,
  }),
  ApiDoc({
    operationId: 'listMods',
    summary: 'List public mods for the catalog page',
    tags: ['Misc'],
    responses: {200: {description: 'Public mods page'}},
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
        facetQueryV1,
      });
      if (req.query.withLikeState === 'true' && req.user?.id) {
        result.mods = await annotateModsWithLikeState(result.mods, req.user.id);
      }
      return res.json(result);
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to list mods', {
        logLabel: 'List mods failed:',
      });
    }
  },
);

router.get(
  '/tags',
  ApiDoc({
    operationId: 'listModTags',
    summary: 'List admin-managed mod tags',
    tags: ['Misc'],
    responses: {200: {description: 'Mod tags'}},
  }),
  async (_req: Request, res: Response) => {
    try {
      return res.json({tags: await listModTags()});
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to list mod tags', {
        logLabel: 'List mod tags failed:',
      });
    }
  },
);

router.get(
  '/:slug/download',
  ApiDoc({
    operationId: 'downloadLatestMod',
    summary: 'Redirect to the latest mod download URL',
    tags: ['Misc'],
    responses: {302: {description: 'Redirect'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const mod = await resolvePublicMod(req, res);
      if (!mod) return;
      const latest = await latestModVersion(mod.id);
      const url = latest?.downloadUrl || mod.downloadUrl;
      if (!url) return res.status(404).json({error: 'Download not found'});
      await recordUniqueModDownload({modId: mod.id, ip: parseClientIp(req)});
      return res.redirect(302, url);
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to download mod', {
        logLabel: 'Download latest mod failed:',
      });
    }
  },
);

router.get(
  '/:slug/isLiked',
  Auth.addUserToRequest(),
  ApiDoc({
    operationId: 'modIsLiked',
    summary: 'Whether the current user liked this mod',
    tags: ['Misc'],
    responses: {200: {description: 'Like state'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const mod = await resolvePublicMod(req, res);
      if (!mod) return;
      if (!req.user?.id) return res.json({isLiked: false, likes: mod.likes});
      const existing = await ModLike.findOne({
        where: {modId: mod.id, userId: req.user.id},
      });
      return res.json({isLiked: Boolean(existing), likes: mod.likes});
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to load like state', {
        logLabel: 'Mod isLiked failed:',
      });
    }
  },
);

router.put(
  '/:slug/like',
  Auth.verified(),
  ApiDoc({
    operationId: 'putModLike',
    summary: 'Like or unlike a mod',
    tags: ['Misc'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Like updated'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const mod = await resolvePublicMod(req, res);
      if (!mod) return;
      const action = req.body?.action;
      if (action !== 'like' && action !== 'unlike') {
        return res.status(400).json({error: 'Invalid action. Must be "like" or "unlike"'});
      }
      const result = await setModLiked({
        modId: mod.id,
        userId: (req.user as {id: string}).id,
        action,
      });
      if (!result.ok) return res.status(result.status).json({error: result.error});
      return res.json({success: true, action, likes: result.likes});
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to toggle like', {
        logLabel: 'Mod like failed:',
      });
    }
  },
);

router.get(
  '/:slug/:version/download',
  ApiDoc({
    operationId: 'downloadModVersion',
    summary: 'Redirect to a specific mod version download URL',
    tags: ['Misc'],
    responses: {302: {description: 'Redirect'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const mod = await resolvePublicMod(req, res);
      if (!mod) return;
      const version = decodeURIComponent(String(req.params.version || ''));
      const row = await findModVersion(mod.id, version);
      if (!row) return res.status(404).json({error: 'Version not found'});
      await recordUniqueModDownload({modId: mod.id, ip: parseClientIp(req)});
      return res.redirect(302, row.downloadUrl);
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to download mod version', {
        logLabel: 'Download mod version failed:',
      });
    }
  },
);

router.get(
  '/:slug/:version',
  Auth.addUserToRequest(),
  ApiDoc({
    operationId: 'getModVersion',
    summary: 'Get a catalog mod at a specific version',
    tags: ['Misc'],
    responses: {200: {description: 'Mod version'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const mod = await resolvePublicMod(req, res);
      if (!mod) return;
      const version = decodeURIComponent(String(req.params.version || ''));
      const row = await findModVersion(mod.id, version);
      if (!row) return res.status(404).json({error: 'Version not found'});
      const detail = await serializeModDetail(mod, {selectedVersion: version});
      if (req.user?.id) {
        const [annotated] = await annotateModsWithLikeState([detail], req.user.id);
        return res.json({mod: annotated});
      }
      return res.json({mod: detail});
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to load mod version', {
        logLabel: 'Get mod version failed:',
      });
    }
  },
);

router.get(
  '/:slug',
  Auth.addUserToRequest(),
  ApiDoc({
    operationId: 'getMod',
    summary: 'Get a catalog mod by slug (latest release)',
    tags: ['Misc'],
    responses: {200: {description: 'Mod'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const mod = await resolvePublicMod(req, res);
      if (!mod) return;
      const detail = await serializeModDetail(mod);
      if (req.user?.id) {
        const [annotated] = await annotateModsWithLikeState([detail], req.user.id);
        return res.json({mod: annotated});
      }
      return res.json({mod: detail});
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to load mod', {
        logLabel: 'Get mod failed:',
      });
    }
  },
);

export default router;
