import { Router, Request, Response } from 'express';
import { ApiDoc } from '@/server/middleware/apiDoc.js';
import {
  idParamSpec,
  errorResponseSchema,
  standardErrorResponses404500,
  standardErrorResponses500,
} from '@/server/schemas/common.js';
import {
  validCreatorSortOptions,
  validCreatorVerificationStatuses,
  permissionFlags,
  type CreatorVerificationStatus,
} from '@/config/constants.js';
import ElasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';
import {
  getCreatorMaxFields,
  CreatorSearchOptions,
} from '@/server/services/elasticsearch/search/creators/creatorSearch.js';
import { parseFacetQueryString, type FacetQueryV1 } from '@/misc/utils/search/facetQuery.js';
import { parseCreatorCurationCountQuery } from '@/misc/utils/search/creatorCurationCountQuery.js';
import { CreatorStatsService } from '@/server/services/core/CreatorStatsService.js';
import {
  computeCreatorFunFacts,
  computeCreatorCurationTypeCounts,
} from '@/server/services/stats/creatorFunFacts.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { PaginationQuery } from '@/server/interfaces/models/index.js';
import { Auth } from '@/server/middleware/auth.js';
import { getSequelizeForModelGroup } from '@/config/db.js';
import Creator from '@/models/credits/Creator.js';
import { CreatorAlias } from '@/models/credits/CreatorAlias.js';
import CurationType from '@/models/curations/CurationType.js';
import {
  creatorAliasStringExistsGlobally,
  creatorDisplayNameTakenByOther,
  replaceCreatorAliasesForCreator,
  validateCreatorAliasListForSelf,
} from '@/server/services/creators/creatorSelfAliases.js';
import {appendCreatorAliasFromRename} from '@/server/services/aliases/nameChangeAliases.js';
import { hasFlag, type PermissionInput } from '@/misc/utils/auth/permissionUtils.js';
import { CUSTOM_PROFILE_BANNERS_ENABLED } from '@/config/env.js';
import { normalizeTufStellarIconVariant } from '@/misc/utils/subscriptions/tufStellarSubscription.js';
import { multerMemoryCdnImage10Mb as bannerUpload } from '@/config/multerMemoryUploads.js';
import { CdnError } from '@/server/services/core/CdnService.js';
import { parseBannerPresetForStorage } from '@/misc/utils/profileBannerPreset.js';
import {PlacementUtilizationService} from '@/server/services/tournaments/PlacementUtilizationService.js';
import {
  assemblePresentationForCreator,
  getPresentationSyncForUser,
} from '@/server/services/profileCustomization/ProfileCustomizationService.js';
import {
  clearBannerPresetForEntity,
  clearCustomBannerForEntity,
  deleteHeaderSurfaceImageForEntity,
  patchHeaderSurfaceStyleForEntity,
  setBannerPresetForEntity,
  setStellarIconVariantForEntity,
  uploadCustomBannerForEntity,
  uploadHeaderSurfaceImageForEntity,
} from '@/server/services/profileCustomization/presentationMutations.js';
import {
  MAX_PROFILE_HEADER_SURFACE_STACK_ENTRY_ID_LENGTH,
  parseProfileHeaderSurfaceStyle,
  ProfileHeaderSurfaceStyleError,
  type ProfileHeaderSurfaceStyle,
} from '@/misc/utils/profileHeaderSurfaceStyle.js';

function parseHeaderSurfaceLayerId(req: Request): string | null {
  const raw = (req.body as { layerId?: unknown })?.layerId ?? req.query.layerId;
  if (typeof raw !== 'string') return null;
  const layerId = raw.trim();
  if (!layerId.length || layerId.length > MAX_PROFILE_HEADER_SURFACE_STACK_ENTRY_ID_LENGTH) {
    return null;
  }
  return layerId;
}
import { CacheInvalidation } from '@/server/middleware/cache.js';
import User from '@/models/auth/User.js';
import { isTufStellarFeatureEnabled } from '@/config/app.config.js';
import {
  BioCanvasProfileError,
  parseBioCanvasBlockId,
  patchBioCanvasForProfile,
  patchPlainBioForEntity,
  serializeBioCanvasApiFields,
  uploadBioCanvasImageForProfile,
} from '@/server/services/bioCanvasProfile.js';

/**
 * v3 creators routes — Elasticsearch-backed.
 *
 * Response shapes mirror /v3/players (flat, no legacy wrapping). Stats fields are the
 * minimal initial set defined by `creatorMapping`; future additions are pure schema
 * extensions that don't change the route contract.
 */

const router: Router = Router();
const elasticsearchService = ElasticsearchService.getInstance();
const creatorStatsService = CreatorStatsService.getInstance();
const creditsSequelize = getSequelizeForModelGroup('credits');

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
const MAX_UPLOAD_CONDITIONS_CHARS = 2000;

const creatorSelfVerificationStatuses = validCreatorVerificationStatuses.filter(
  (s): s is Exclude<CreatorVerificationStatus, 'pending'> => s !== 'pending',
);

function parseLimit(raw: unknown, fallback = DEFAULT_LIMIT): number {
  const n = parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_LIMIT, Math.max(1, n));
}

function parseOffset(raw: unknown): number {
  const n = parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function parseFilters(raw: unknown): Record<string, any> | undefined {
  if (!raw || typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, any>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function parseCreatorFacetQueryParam(
  raw: unknown,
): { facetQueryV1: FacetQueryV1 | undefined } | { error: string } {
  const parsed = parseFacetQueryString(typeof raw === 'string' ? raw : undefined);
  if (parsed?.tags) {
    return { error: 'facetQuery.tags is not supported for creator search' };
  }
  return { facetQueryV1: parsed ?? undefined };
}

/** Text, @username, facet curation filter, or manual count tokens (e.g. C3>3). */
function creatorLeaderboardHasActiveQuery(
  rawQuery: string | undefined,
  facetQueryV1: FacetQueryV1 | undefined,
): boolean {
  if (facetQueryV1?.curationTypes) return true;
  const raw = (rawQuery ?? '').trim();
  if (!raw) return false;
  if (raw.startsWith('@')) return true;
  const { hasCountConstraints, cleanedText } = parseCreatorCurationCountQuery(raw);
  if (hasCountConstraints) return true;
  return cleanedText.length > 0;
}

router.get(
  '/search',
  ApiDoc({
    operationId: 'v3GetCreatorsSearch',
    summary: 'Search creators (v3)',
    description:
      'Elasticsearch-backed creator search. Accepts text, `@username`, curation count tokens (e.g. `C3>3`), and optional `facetQuery` JSON v1 (curationTypes only). Returns a flat list sorted by relevance.',
    tags: ['Database', 'Creators', 'v3'],
    query: {
      query: { schema: { type: 'string' } },
      limit: { schema: { type: 'string' } },
      offset: { schema: { type: 'string' } },
      filters: { schema: { type: 'string' } },
      facetQuery: { description: 'Facet filter JSON v1 (curationTypes only)', schema: { type: 'string' } },
    },
    responses: {
      200: { description: 'Paginated search results' },
      ...standardErrorResponses500,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const query = String(req.query.query ?? '').trim();
      const limit = parseLimit(req.query.limit);
      const offset = parseOffset(req.query.offset);
      const filters = parseFilters(req.query.filters);
      const facetResult = parseCreatorFacetQueryParam(req.query.facetQuery);
      if ('error' in facetResult) {
        return res.status(400).json({ error: facetResult.error });
      }

      const options: CreatorSearchOptions = {
        rawQuery: query || undefined,
        filters,
        facetQueryV1: facetResult.facetQueryV1,
        limit,
        offset,
      };

      const { total, hits } = await elasticsearchService.searchCreators(options);
      return res.json({ total, results: hits, limit, offset });
    } catch (error) {
      logger.error('[v3 /creators/search] failure', error);
      return res.status(500).json({
        error: 'Failed to search creators',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

router.get(
  '/leaderboard',
  ApiDoc({
    operationId: 'v3GetCreatorLeaderboard',
    summary: 'Creator leaderboard (v3)',
    description:
      'Elasticsearch-backed creator leaderboard. Supports sort, numeric range filters, verificationStatus filter (single value or array), text/`@username` query, curation count tokens (e.g. `C3>3`), and optional `facetQuery` JSON v1 (curationTypes only). Returns `maxFields` aggregations for UI filter ceilings.',
    tags: ['Database', 'Creators', 'v3'],
    query: {
      sortBy: { schema: { type: 'string' } },
      order: { schema: { type: 'string' } },
      query: { schema: { type: 'string' } },
      offset: { schema: { type: 'string' } },
      limit: { schema: { type: 'string' } },
      filters: { schema: { type: 'string' } },
      facetQuery: { description: 'Facet filter JSON v1 (curationTypes only)', schema: { type: 'string' } },
      page: { schema: { type: 'string' } },
    },
    responses: {
      200: { description: 'Leaderboard results' },
      400: { schema: errorResponseSchema },
      ...standardErrorResponses500,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const { page, offset, limit } = req.query as unknown as PaginationQuery;
      const sortBy = (req.query.sortBy as string) || 'chartsTotal';
      const order = ((req.query.order as string) || 'desc').toLowerCase();
      const rawQuery = (req.query.query as string) || undefined;
      const filters = parseFilters(req.query.filters);
      const facetResult = parseCreatorFacetQueryParam(req.query.facetQuery);
      if ('error' in facetResult) {
        return res.status(400).json({ error: facetResult.error });
      }

      if (!validCreatorSortOptions.includes(sortBy)) {
        return res.status(400).json({
          error: `Invalid sortBy option. Valid options are: ${validCreatorSortOptions.join(', ')}`,
        });
      }

      const effectiveLimit = parseLimit(limit);
      const effectiveOffset = parseOffset(offset);
      const hasActiveQuery = creatorLeaderboardHasActiveQuery(
        rawQuery,
        facetResult.facetQueryV1,
      );

      const options: CreatorSearchOptions = {
        rawQuery,
        sortBy,
        order: order === 'asc' ? 'asc' : 'desc',
        filters,
        facetQueryV1: facetResult.facetQueryV1,
        limit: effectiveLimit,
        offset: effectiveOffset,
        requireHasCharts: !hasActiveQuery,
      };

      const [{ total, hits }, maxFields] = await Promise.all([
        elasticsearchService.searchCreators(options),
        getCreatorMaxFields(),
      ]);

      const resultsWithRank = hits.map((doc: any, i: number) => ({
        ...doc,
        // Positional rank is fine here because the creator leaderboard does not have
        // a globally-sticky metric like player rankedScore — every sort is a real sort.
        rank: effectiveOffset + i + 1,
      }));

      return res.json({
        count: total,
        results: resultsWithRank,
        page,
        offset: effectiveOffset,
        limit: effectiveLimit,
        maxFields,
      });
    } catch (error) {
      logger.error('[v3 /creators/leaderboard] failure', error);
      return res.status(500).json({
        error: 'Failed to fetch creator leaderboard',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

router.patch(
  '/me/name',
  Auth.user(),
  ApiDoc({
    operationId: 'v3PatchCreatorMeName',
    summary: 'Update my creator display name (v3)',
    description:
      'Requires an authenticated user with `creatorId` set. Updates that creator row only; name must be unique among creators.',
    tags: ['Database', 'Creators', 'v3'],
    security: ['bearerAuth'],
    responses: {
      200: {description: 'Updated name'},
      ...standardErrorResponses404500,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const user = req.user;
      if (!user?.id) {
        return res.status(401).json({error: 'Unauthorized'});
      }

      const id = Number(user.creatorId);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({error: 'No creator profile linked to this account'});
      }

      const body = req.body as {name?: unknown};
      const rawName = typeof body.name === 'string' ? body.name.trim() : '';
      if (!rawName) {
        return res.status(400).json({error: 'Name is required'});
      }
      if (rawName.length < 2) {
        return res.status(400).json({error: 'Name must be at least 2 characters'});
      }
      if (rawName.length > 100) {
        return res.status(400).json({error: 'Name must be at most 100 characters'});
      }

      const creatorRow = await Creator.findByPk(id, {
        attributes: ['id', 'name', 'userId'],
      });
      if (!creatorRow) {
        return res.status(404).json({error: 'Creator not found'});
      }

      const currentName = String(creatorRow.get('name') ?? creatorRow.name ?? '');
      if (rawName === currentName) {
        return res.json({name: rawName});
      }

      const seq = Creator.sequelize!;
      if (await creatorDisplayNameTakenByOther(seq, id, rawName)) {
        return res.status(400).json({error: 'Creator name already taken'});
      }
      if (await creatorAliasStringExistsGlobally(seq, rawName)) {
        return res.status(400).json({
          error:
            'That name matches an existing creator alias. Change or remove the conflicting alias first.',
        });
      }

      await appendCreatorAliasFromRename(id, currentName, rawName);
      await Creator.update({name: rawName}, {where: {id}});
      // Elasticsearch: CDC projectors (`creators` ➔ indexCreator + level fanout on name change).

      return res.json({name: rawName});
    } catch (error) {
      logger.error('[v3 PATCH /creators/me/name] failure', error);
      return res.status(500).json({
        error: 'Failed to update creator name',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

router.patch(
  '/me/aliases',
  Auth.user(),
  ApiDoc({
    operationId: 'v3PatchCreatorMeAliases',
    summary: 'Replace my creator aliases (v3)',
    description:
      'Requires `creatorId` on the user. Body: `aliases: string[]` (full replacement, max 20). ' +
      'Each alias must be unique vs other creators’ names and aliases (case-insensitive), ' +
      'and cannot match this creator’s display name.',
    tags: ['Database', 'Creators', 'v3'],
    security: ['bearerAuth'],
    responses: {
      200: {description: 'Updated aliases'},
      ...standardErrorResponses404500,
    },
  }),
  async (req: Request, res: Response) => {
    const transaction = await creditsSequelize.transaction();
    try {
      const user = req.user;
      if (!user?.id) {
        await transaction.rollback();
        return res.status(401).json({error: 'Unauthorized'});
      }

      const id = Number(user.creatorId);
      if (!Number.isFinite(id) || id <= 0) {
        await transaction.rollback();
        return res.status(400).json({error: 'No creator profile linked to this account'});
      }

      const creatorRow = await Creator.findByPk(id, {
        attributes: ['id', 'name'],
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!creatorRow) {
        await transaction.rollback();
        return res.status(404).json({error: 'Creator not found'});
      }

      const displayName = String(creatorRow.get('name') ?? creatorRow.name ?? '');
      const seq = Creator.sequelize!;
      const validated = await validateCreatorAliasListForSelf(
        seq,
        id,
        displayName,
        (req.body as {aliases?: unknown}).aliases,
      );
      if (!validated.ok) {
        await transaction.rollback();
        return res.status(400).json({error: validated.error});
      }

      await replaceCreatorAliasesForCreator(id, validated.names, transaction);
      await transaction.commit();
      // Elasticsearch: CDC projectors (`creator_aliases` ➔ indexCreator).

      const aliases = await CreatorAlias.findAll({
        where: {creatorId: id},
        attributes: ['id', 'name'],
        order: [['id', 'ASC']],
      });

      return res.json({
        aliases: aliases.map((a) => ({id: a.id, name: a.name})),
      });
    } catch (error) {
      await transaction.rollback();
      logger.error('[v3 PATCH /creators/me/aliases] failure', error);
      return res.status(500).json({
        error: 'Failed to update creator aliases',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

router.patch(
  '/me/bio',
  Auth.user(),
  ApiDoc({
    operationId: 'v3PatchCreatorMeBio',
    summary: 'Update my creator bio (v3)',
    description:
      'Requires an authenticated user with `creatorId` set. Updates that creator row only.',
    tags: ['Database', 'Creators', 'v3'],
    security: ['bearerAuth'],
    requestBody: {
      description: 'Bio text (string or null). Empty string clears.',
      required: true,
      schema: {
        type: 'object',
        properties: {
          bio: { type: 'string', nullable: true },
        },
        required: ['bio'],
      },
    },
    responses: {
      200: { description: 'Updated bio' },
      ...standardErrorResponses404500,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const user = req.user;
      if (!user?.id) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const id = Number(user.creatorId);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: 'No creator profile linked to this account' });
      }

      const body = req.body as { bio?: unknown };
      if (!Object.prototype.hasOwnProperty.call(body, 'bio')) {
        return res.status(400).json({ error: 'Request body must include bio (string or null)' });
      }

      let nextBio: string | null;
      if (body.bio == null) {
        nextBio = null;
      } else if (typeof body.bio === 'string') {
        const trimmed = body.bio.trim();
        if (trimmed.length > 2000) {
          return res.status(400).json({ error: 'Bio must be at most 2000 characters' });
        }
        nextBio = trimmed.length ? trimmed : null;
      } else {
        return res.status(400).json({ error: 'Bio must be a string or null' });
      }

      const result = await patchPlainBioForEntity('creator', id, nextBio);
      await invalidateLinkedUserForCreator(id);

      return res.json(result);
    } catch (error) {
      logger.error('[v3 PATCH /creators/me/bio] failure', error);
      return res.status(500).json({
        error: 'Failed to update creator bio',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

router.patch(
  '/me/bio-canvas',
  Auth.tufStellarUser(),
  ApiDoc({
    operationId: 'v3PatchCreatorMeBioCanvas',
    summary: 'Update my creator bio canvas (v3)',
    description:
      'Requires TUFStellar access. Saves block document and derives plaintext bio for search.',
    tags: ['Database', 'Creators', 'v3'],
    security: ['bearerAuth'],
    requestBody: {
      required: true,
      schema: {
        type: 'object',
        properties: {
          canvas: { type: 'object', nullable: true },
        },
        required: ['canvas'],
      },
    },
    responses: {
      200: { description: 'Updated bio canvas' },
      ...standardErrorResponses404500,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const user = req.user;
      if (!user?.id) return res.status(401).json({ error: 'Unauthorized' });
      if (!isTufStellarFeatureEnabled()) {
        return res.status(403).json({ error: 'TUFStellar is not available on this deployment' });
      }

      const id = Number(user.creatorId);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: 'No creator profile linked to this account' });
      }

      const body = req.body as { canvas?: unknown };
      if (!Object.prototype.hasOwnProperty.call(body, 'canvas')) {
        return res.status(400).json({ error: 'Request body must include canvas (object or null)' });
      }

      const result = await patchBioCanvasForProfile(Creator, id, body.canvas);

      await elasticsearchService.reindexCreators([id]);
      await invalidateLinkedUserForCreator(id);

      return res.json(result);
    } catch (error) {
      if (error instanceof BioCanvasProfileError) {
        return res.status(error.status).json({ error: error.message });
      }
      logger.error('[v3 PATCH /creators/me/bio-canvas] failure', error);
      return res.status(500).json({
        error: 'Failed to update bio canvas',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

router.post(
  '/me/bio-canvas/image',
  Auth.tufStellarUser(),
  bannerUpload.single('image'),
  ApiDoc({
    operationId: 'v3PostCreatorMeBioCanvasImage',
    summary: 'Upload creator bio canvas image block asset',
    tags: ['Database', 'Creators', 'v3'],
    security: ['bearerAuth'],
    responses: {
      200: { description: 'Uploaded' },
      400: { description: 'No file or invalid blockId', schema: errorResponseSchema },
      401: { description: 'Unauthorized', schema: errorResponseSchema },
      403: { description: 'Forbidden', schema: errorResponseSchema },
      500: { description: 'Server error', schema: errorResponseSchema },
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const user = req.user;
      if (!user?.id) return res.status(401).json({ error: 'Unauthorized' });
      if (!isTufStellarFeatureEnabled()) {
        return res.status(403).json({ error: 'TUFStellar is not available on this deployment' });
      }

      const id = Number(user.creatorId);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: 'No creator profile linked to this account' });
      }
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded', code: 'NO_FILE' });
      }

      const blockId = parseBioCanvasBlockId(req);
      if (!blockId) {
        return res.status(400).json({ error: 'blockId is required' });
      }

      const uploadResult = await uploadBioCanvasImageForProfile(
        Creator,
        id,
        blockId,
        req.file,
      );

      await elasticsearchService.reindexCreators([id]);
      await invalidateLinkedUserForCreator(id);

      return res.json(uploadResult);
    } catch (error) {
      if (error instanceof BioCanvasProfileError) {
        return res.status(error.status).json({ error: error.message });
      }
      if (error instanceof CdnError) {
        return res.status(400).json({
          error: error.message,
          code: error.code,
          details: error.details,
        });
      }
      logger.error('[v3 POST /creators/me/bio-canvas/image] failure', error);
      return res.status(500).json({ error: 'Failed to upload bio canvas image' });
    }
  },
);

router.patch(
  '/me/upload-conditions',
  Auth.user(),
  ApiDoc({
    operationId: 'v3PatchCreatorMeUploadConditions',
    summary: 'Update my creator chart upload conditions (v3)',
    description:
      'Requires an authenticated user with `creatorId` set. Free-text policy for when/how charts may be uploaded.',
    tags: ['Database', 'Creators', 'v3'],
    security: ['bearerAuth'],
    requestBody: {
      description: 'uploadConditions (string or null). Empty string clears.',
      required: true,
      schema: {
        type: 'object',
        properties: {
          uploadConditions: { type: 'string', nullable: true },
        },
        required: ['uploadConditions'],
      },
    },
    responses: {
      200: { description: 'Updated upload conditions' },
      ...standardErrorResponses404500,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const user = req.user;
      if (!user?.id) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const id = Number(user.creatorId);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: 'No creator profile linked to this account' });
      }

      const body = req.body as { uploadConditions?: unknown };
      if (!Object.prototype.hasOwnProperty.call(body, 'uploadConditions')) {
        return res
          .status(400)
          .json({ error: 'Request body must include uploadConditions (string or null)' });
      }

      let next: string | null;
      if (body.uploadConditions == null) {
        next = null;
      } else if (typeof body.uploadConditions === 'string') {
        const trimmed = body.uploadConditions.trim();
        if (trimmed.length > MAX_UPLOAD_CONDITIONS_CHARS) {
          return res.status(400).json({
            error: `Upload conditions must be at most ${MAX_UPLOAD_CONDITIONS_CHARS} characters`,
          });
        }
        next = trimmed.length ? trimmed : null;
      } else {
        return res.status(400).json({ error: 'uploadConditions must be a string or null' });
      }

      const exists = await Creator.findByPk(id, { attributes: ['id'] });
      if (!exists) {
        return res.status(404).json({ error: 'Creator not found' });
      }

      await Creator.update({ uploadConditions: next }, { where: { id } });
      await elasticsearchService.reindexCreators([id]);
      await invalidateLinkedUserForCreator(id);

      return res.json({ uploadConditions: next });
    } catch (error) {
      logger.error('[v3 PATCH /creators/me/upload-conditions] failure', error);
      return res.status(500).json({
        error: 'Failed to update upload conditions',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

router.patch(
  '/me/verification-status',
  Auth.user(),
  ApiDoc({
    operationId: 'v3PatchCreatorMeVerificationStatus',
    summary: 'Update my creator verification status (v3)',
    description:
      'Linked creator only. Allowed values: `declined`, `conditional`, `allowed`. `pending` is not allowed (use staff workflows).',
    tags: ['Database', 'Creators', 'v3'],
    security: ['bearerAuth'],
    requestBody: {
      required: true,
      schema: {
        type: 'object',
        properties: {
          verificationStatus: {
            type: 'string',
            enum: ['declined', 'conditional', 'allowed'],
          },
        },
        required: ['verificationStatus'],
      },
    },
    responses: {
      200: { description: 'Updated verification status' },
      ...standardErrorResponses404500,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const user = req.user;
      if (!user?.id) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const id = Number(user.creatorId);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: 'No creator profile linked to this account' });
      }

      const body = req.body as { verificationStatus?: unknown };
      const raw = body.verificationStatus;
      if (typeof raw !== 'string' || !raw.trim()) {
        return res.status(400).json({ error: 'verificationStatus is required' });
      }
      const nextStatus = raw.trim() as CreatorVerificationStatus;
      if (nextStatus === 'pending') {
        return res.status(400).json({ error: 'Creators cannot set verification status to pending' });
      }
      if (!(creatorSelfVerificationStatuses as readonly string[]).includes(nextStatus)) {
        return res.status(400).json({
          error: `Invalid verificationStatus. Must be one of: ${creatorSelfVerificationStatuses.join(', ')}`,
        });
      }

      const exists = await Creator.findByPk(id, { attributes: ['id'] });
      if (!exists) {
        return res.status(404).json({ error: 'Creator not found' });
      }

      await Creator.update(
        { verificationStatus: nextStatus },
        { where: { id } },
      );
      await elasticsearchService.reindexCreators([id]);
      await invalidateLinkedUserForCreator(id);

      return res.json({ verificationStatus: nextStatus });
    } catch (error) {
      logger.error('[v3 PATCH /creators/me/verification-status] failure', error);
      return res.status(500).json({
        error: 'Failed to update verification status',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

router.get(
  '/:id([0-9]{1,20})',
  ApiDoc({
    operationId: 'v3GetCreator',
    summary: 'Get creator (v3)',
    description: 'Fetches the creator Elasticsearch document by id.',
    tags: ['Database', 'Creators', 'v3'],
    params: { id: idParamSpec },
    responses: {
      200: { description: 'Creator detail' },
      ...standardErrorResponses404500,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid creator id' });
      }

      const doc = await elasticsearchService.getCreatorDocumentById(id);
      if (!doc) return res.status(404).json({ error: 'Creator not found' });

      return res.json(doc);
    } catch (error) {
      logger.error('[v3 /creators/:id] failure', error);
      return res.status(500).json({
        error: 'Failed to fetch creator',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

router.get(
  '/:id([0-9]{1,20})/profile',
  Auth.addUserToRequest(),
  ApiDoc({
    operationId: 'v3GetCreatorProfile',
    summary: 'Get creator profile (v3)',
    description:
      'Creator profile page payload: ES document + DB-sourced enriched fields (aliases, linked user, recent level ids).',
    tags: ['Database', 'Creators', 'v3'],
    params: { id: idParamSpec },
    responses: {
      200: { description: 'Creator profile' },
      ...standardErrorResponses404500,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid creator id' });
      }

      const isOwnProfile = Boolean(req.user?.creatorId && req.user.creatorId === id);

      const [doc, enriched, funFacts, curationTypeCounts, creatorRow, presentation] = await Promise.all([
        elasticsearchService.getCreatorDocumentById(id),
        creatorStatsService.getEnrichedCreator(id),
        computeCreatorFunFacts(id),
        computeCreatorCurationTypeCounts(id),
        Creator.findByPk(id, {
          attributes: [
            'id',
            'uploadConditions',
            'displayCurationTypeIds',
            'placementCardLayout',
            'placementDisplayMode',
            'hiddenPlacementIds',
            'placementOrderIds',
          ],
        }),
        assemblePresentationForCreator(id),
      ]);

      const placementService = PlacementUtilizationService.getInstance();
      const [tournamentPlacements, equippedAvatarFrame, placementEntitlements, placementDisplayNodes] =
        await Promise.all([
          placementService.getPlacementsForCreator(id, {
            includeProfileHidden: isOwnProfile,
          }),
          placementService.getEquippedCosmetic({creatorId: id}, 'avatar_frame'),
          isOwnProfile
            ? placementService.listEntitlements({creatorId: id})
            : Promise.resolve([]),
          isOwnProfile
            ? placementService.getDisplayTree({creatorId: id})
            : Promise.resolve([]),
        ]);


      if (!doc && !enriched) return res.status(404).json({ error: 'Creator not found' });

      const stellarOn = isTufStellarFeatureEnabled();

      // Prefer the ES document for the canonical fields (it carries the ES-stable
      // shape clients depend on). Fall back to the DB row if ES is missing the doc
      // for some reason (e.g. mid-reindex).
      const baseDoc =
        doc ??
        (enriched
          ? {
              id: enriched.creator?.id ?? id,
              name: enriched.creator?.name ?? '',
              verificationStatus: enriched.creator?.verificationStatus ?? 'allowed',
              aliases: enriched.aliases.map((a) => ({ id: a.id, name: a.name })),
              user: enriched.user
                ? {
                    id: enriched.user.id,
                    username: enriched.user.username,
                    nickname: enriched.user.nickname ?? null,
                    avatarUrl: enriched.user.avatarUrl ?? null,
                    playerId: enriched.user.playerId ?? null,
                    permissionFlags: enriched.user.permissionFlags ?? 0,
                    tufStellarSubscriptionExpiresAt:
                      enriched.user.tufStellarSubscriptionExpiresAt ?? null,
                  }
                : null,
              bannerPreset: presentation.bannerPreset ?? null,
              customBannerId: presentation.customBannerId ?? null,
              customBannerUrl: presentation.customBannerUrl ?? null,
              tufStellarIconVariant: stellarOn
                ? normalizeTufStellarIconVariant(presentation.tufStellarIconVariant)
                : '1',
              chartsCharted: enriched.stats.chartsCharted,
              chartsVfxed: enriched.stats.chartsVfxed,
              chartsTeamed: enriched.stats.chartsTeamed,
              chartsTotal: enriched.stats.chartsTotal,
              totalChartClears: enriched.stats.totalChartClears,
              totalChartLikes: enriched.stats.totalChartLikes,
              topRole: null,
            }
          : null);

      if (!baseDoc) return res.status(404).json({ error: 'Creator not found' });

      // ES doc can lag behind the `creators` row (e.g. before indexCreator runs). Identity
      // fields that users edit in DB must come from enrichment so profile/header stay correct.
      let responseDoc: Record<string, unknown> = baseDoc as Record<string, unknown>;
      if (doc && enriched?.creator) {
        responseDoc = {
          ...(doc as Record<string, unknown>),
          name: enriched.creator.name ?? (doc as { name?: string }).name ?? '',
          verificationStatus:
            enriched.creator.verificationStatus ??
            (doc as { verificationStatus?: string }).verificationStatus ??
            'allowed',
          aliases: enriched.aliases.map((a) => ({ id: a.id, name: a.name })),
          user: enriched.user
            ? {
                id: enriched.user.id,
                username: enriched.user.username,
                nickname: enriched.user.nickname ?? null,
                avatarUrl: enriched.user.avatarUrl ?? null,
                playerId: enriched.user.playerId ?? null,
                permissionFlags: enriched.user.permissionFlags ?? 0,
                tufStellarSubscriptionExpiresAt:
                  enriched.user.tufStellarSubscriptionExpiresAt ?? null,
              }
            : ((doc as { user?: unknown }).user ?? null),
        };
      }

      const recentLevelIds = enriched?.recentLevelIds ?? [];

      // Admin UI expects `creator.creatorAliases[].name` for editing, while the public
      // profile UI uses `aliases: {id,name}[]`. Always include both to avoid
      // accidentally dropping aliases when the admin popup saves.
      const aliases =
        enriched?.aliases?.map((a) => ({ id: a.id, name: a.name })) ??
        (Array.isArray((responseDoc as any)?.aliases) ? (responseDoc as any).aliases : []);
      const creatorAliases = Array.isArray(aliases)
        ? aliases
            .map((a: any) => (typeof a?.name === 'string' ? a.name.trim() : ''))
            .filter((s: string) => s.length > 0)
            .map((name: string) => ({ name }))
        : [];

      const rawDisplay = creatorRow?.get?.('displayCurationTypeIds') ?? creatorRow?.displayCurationTypeIds;
      const displayCurationTypeIds = Array.isArray(rawDisplay)
        ? rawDisplay
            .map((x: unknown) => Number(x))
            .filter((n: number) => Number.isFinite(n))
            .slice(0, 5)
        : [];

      const presentationPatch = {
        bio: presentation.bio,
        bioCanvas: presentation.bioCanvas,
        bioCanvasImageAssets: presentation.bioCanvasImageAssets,
        bannerPreset: presentation.bannerPreset,
        customBannerId: presentation.customBannerId,
        customBannerUrl: presentation.customBannerUrl,
        profileHeaderSurfaceStyle: presentation.profileHeaderSurfaceStyle,
        profileHeaderSurfaceImageAssets: presentation.profileHeaderSurfaceImageAssets,
        tufStellarIconVariant: stellarOn
          ? normalizeTufStellarIconVariant(presentation.tufStellarIconVariant)
          : '1',
        uploadConditions:
          creatorRow &&
          typeof creatorRow.uploadConditions === 'string' &&
          creatorRow.uploadConditions.trim().length
            ? creatorRow.uploadConditions.trim()
            : null,
        ...(creatorRow
          ? {
              placementDisplayMode:
                creatorRow.placementDisplayMode === 'customLayers'
                  ? 'customLayers'
                  : 'defaultHierarchy',
              ...(isOwnProfile
                ? {
                    hiddenPlacementIds: Array.isArray(creatorRow.hiddenPlacementIds)
                      ? creatorRow.hiddenPlacementIds
                      : [],
                    placementOrderIds: Array.isArray(creatorRow.placementOrderIds)
                      ? creatorRow.placementOrderIds
                      : [],
                  }
                : {}),
              placementCardLayout:
                creatorRow.placementCardLayout === 'iconRail' ? 'iconRail' : 'default',
            }
          : {}),
        ...(isOwnProfile && req.user?.id
          ? { presentationSync: await getPresentationSyncForUser(req.user.id) }
          : {}),
      };

      return res.json({
        ...(responseDoc as Record<string, unknown>),
        ...presentationPatch,
        aliases,
        creatorAliases,
        recentLevelIds,
        funFacts,
        curationTypeCounts,
        displayCurationTypeIds,
        tournamentPlacements,
        equippedAvatarFrame,
        ...(isOwnProfile ? {placementEntitlements, placementDisplayNodes} : {}),
      });

    } catch (error) {
      logger.error('[v3 /creators/:id/profile] failure', error);
      return res.status(500).json({
        error: 'Failed to fetch creator profile',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

router.patch(
  '/:id([0-9]{1,20})/display-curation-types',
  Auth.addUserToRequest(),
  ApiDoc({
    operationId: 'v3PatchCreatorDisplayCurationTypes',
    summary: 'Update creator profile header curation slots (v3)',
    description:
      'Owner (linked user) or HEAD_CURATOR / SUPER_ADMIN may set up to 5 curation type ids; each must appear on at least one level credited to this creator.',
    tags: ['Database', 'Creators', 'v3'],
    params: {id: idParamSpec},
    responses: {
      200: {description: 'Updated display ids'},
      ...standardErrorResponses404500,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const user = req.user;
      if (!user?.id) {
        return res.status(401).json({error: 'Unauthorized'});
      }
      const permUser = user as PermissionInput;

      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({error: 'Invalid creator id'});
      }

      const body = req.body as {ids?: unknown};
      if (!Array.isArray(body?.ids)) {
        return res.status(400).json({error: 'Request body must include ids: number[]'});
      }

      const normalized = [
        ...new Set(
          body.ids
            .map((x) => Number(x))
            .filter((n) => Number.isFinite(n) && n > 0),
        ),
      ].slice(0, 5);

      const isOwner = user.creatorId != null && Number(user.creatorId) === id;
      const isElevated =
        hasFlag(permUser, permissionFlags.SUPER_ADMIN) ||
        hasFlag(permUser, permissionFlags.HEAD_CURATOR);
      if (!isOwner && !isElevated) {
        return res.status(403).json({error: 'Forbidden'});
      }

      const creatorExists = await Creator.findByPk(id, {attributes: ['id']});
      if (!creatorExists) {
        return res.status(404).json({error: 'Creator not found'});
      }

      const counts = await computeCreatorCurationTypeCounts(id);
      for (const tid of normalized) {
        const c = counts[String(tid)] ?? 0;
        if (!c || c <= 0) {
          return res.status(400).json({
            error: `Curation type ${tid} is not available (no credited level with that type).`,
          });
        }
      }

      if (normalized.length) {
        const found = await CurationType.findAll({
          where: {id: normalized},
          attributes: ['id'],
        });
        if (found.length !== normalized.length) {
          return res.status(400).json({error: 'One or more curation type ids are invalid'});
        }
      }

      await Creator.update({displayCurationTypeIds: normalized.length ? normalized : null}, {where: {id}});

      return res.json({displayCurationTypeIds: normalized});
    } catch (error) {
      logger.error('[v3 PATCH /creators/:id/display-curation-types] failure', error);
      return res.status(500).json({
        error: 'Failed to update display curation types',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

function parseCreatorRouteId(req: Request): number | null {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return null;
  return id;
}

/** Ensures `:id` matches the authenticated user's linked creator profile. */
function resolveOwnCreatorRouteId(
  req: Request,
  res: Response,
  user: { creatorId?: number | string | null },
): number | null {
  const id = parseCreatorRouteId(req);
  if (id === null) {
    res.status(400).json({ error: 'Invalid creator id' });
    return null;
  }
  if (user.creatorId == null) {
    res.status(400).json({ error: 'No creator profile linked to this account' });
    return null;
  }
  if (Number(user.creatorId) !== id) {
    res.status(403).json({ error: 'Forbidden' });
    return null;
  }
  return id;
}

async function invalidateLinkedUserForCreator(creatorId: number): Promise<void> {
  const row = await User.findOne({ where: { creatorId }, attributes: ['id'] });
  if (row?.id) {
    await CacheInvalidation.invalidateUser(row.id);
  }
}

router.patch(
  '/:id([0-9]{1,20})/managed-update',
  Auth.addUserToRequest(),
  ApiDoc({
    operationId: 'v3PatchCreatorManagedUpdate',
    summary: 'Update creator fields (curator/admin) (v3)',
    description:
      'HEAD_CURATOR or SUPER_ADMIN. Partial body: `name`, `aliases` (full replacement), `verificationStatus` (including `pending`), `uploadConditions`. At least one field required.',
    tags: ['Database', 'Creators', 'v3'],
    security: ['bearerAuth'],
    params: { id: idParamSpec },
    responses: {
      200: { description: 'Updated creator' },
      ...standardErrorResponses404500,
    },
  }),
  async (req: Request, res: Response) => {
    const transaction = await creditsSequelize.transaction();
    try {
      const user = req.user;
      if (!user?.id) {
        await transaction.rollback();
        return res.status(401).json({ error: 'Unauthorized' });
      }
      const permUser = user as PermissionInput;
      const isElevated =
        hasFlag(permUser, permissionFlags.SUPER_ADMIN) ||
        hasFlag(permUser, permissionFlags.HEAD_CURATOR);
      if (!isElevated) {
        await transaction.rollback();
        return res.status(403).json({ error: 'Forbidden' });
      }

      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id) || id <= 0) {
        await transaction.rollback();
        return res.status(400).json({ error: 'Invalid creator id' });
      }

      const body = req.body as {
        name?: unknown;
        aliases?: unknown;
        verificationStatus?: unknown;
        uploadConditions?: unknown;
      };

      const hasName = Object.prototype.hasOwnProperty.call(body, 'name');
      const hasAliases = Object.prototype.hasOwnProperty.call(body, 'aliases');
      const hasVerification = Object.prototype.hasOwnProperty.call(body, 'verificationStatus');
      const hasUploadConditions = Object.prototype.hasOwnProperty.call(body, 'uploadConditions');

      if (!hasName && !hasAliases && !hasVerification && !hasUploadConditions) {
        await transaction.rollback();
        return res.status(400).json({
          error: 'Request body must include at least one of: name, aliases, verificationStatus, uploadConditions',
        });
      }

      const creatorRow = await Creator.findByPk(id, {
        attributes: ['id', 'name'],
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!creatorRow) {
        await transaction.rollback();
        return res.status(404).json({ error: 'Creator not found' });
      }

      const currentName = String(creatorRow.get('name') ?? creatorRow.name ?? '');
      const seq = Creator.sequelize!;

      const updatePayload: Record<string, unknown> = {};
      let nextName = currentName;

      if (hasName) {
        if (typeof body.name !== 'string') {
          await transaction.rollback();
          return res.status(400).json({ error: 'name must be a string' });
        }
        const rawName = body.name.trim();
        if (rawName.length < 2) {
          await transaction.rollback();
          return res.status(400).json({ error: 'Name must be at least 2 characters' });
        }
        if (rawName.length > 100) {
          await transaction.rollback();
          return res.status(400).json({ error: 'Name must be at most 100 characters' });
        }
        if (rawName !== currentName) {
          if (await creatorDisplayNameTakenByOther(seq, id, rawName)) {
            await transaction.rollback();
            return res.status(400).json({ error: 'Creator name already taken' });
          }
          if (await creatorAliasStringExistsGlobally(seq, rawName)) {
            await transaction.rollback();
            return res.status(400).json({
              error:
                'That name matches an existing creator alias. Change or remove the conflicting alias first.',
            });
          }
          await appendCreatorAliasFromRename(id, currentName, rawName, transaction);
        }
        updatePayload.name = rawName;
        nextName = rawName;
      }

      if (hasVerification) {
        if (typeof body.verificationStatus !== 'string') {
          await transaction.rollback();
          return res.status(400).json({ error: 'verificationStatus must be a string' });
        }
        const vs = body.verificationStatus.trim() as CreatorVerificationStatus;
        if (!(validCreatorVerificationStatuses as readonly string[]).includes(vs)) {
          await transaction.rollback();
          return res.status(400).json({
            error: `Invalid verificationStatus. Must be one of: ${validCreatorVerificationStatuses.join(', ')}`,
          });
        }
        updatePayload.verificationStatus = vs;
      }

      if (hasUploadConditions) {
        if (body.uploadConditions != null && typeof body.uploadConditions !== 'string') {
          await transaction.rollback();
          return res.status(400).json({ error: 'uploadConditions must be a string or null' });
        }
        let nextUpload: string | null;
        if (body.uploadConditions == null) {
          nextUpload = null;
        } else {
          const trimmed = body.uploadConditions.trim();
          if (trimmed.length > MAX_UPLOAD_CONDITIONS_CHARS) {
            await transaction.rollback();
            return res.status(400).json({
              error: `uploadConditions must be at most ${MAX_UPLOAD_CONDITIONS_CHARS} characters`,
            });
          }
          nextUpload = trimmed.length ? trimmed : null;
        }
        updatePayload.uploadConditions = nextUpload;
      }

      if (Object.keys(updatePayload).length > 0) {
        await Creator.update(updatePayload, { where: { id }, transaction });
      }

      let aliasRows: { id: number; name: string }[] = [];
      if (hasAliases) {
        const validated = await validateCreatorAliasListForSelf(
          seq,
          id,
          nextName,
          body.aliases,
        );
        if (!validated.ok) {
          await transaction.rollback();
          return res.status(400).json({ error: validated.error });
        }
        await replaceCreatorAliasesForCreator(id, validated.names, transaction);
        aliasRows = await CreatorAlias.findAll({
          where: { creatorId: id },
          attributes: ['id', 'name'],
          order: [['id', 'ASC']],
          transaction,
        });
      }

      await transaction.commit();

      await elasticsearchService.reindexCreators([id]);
      await invalidateLinkedUserForCreator(id);

      if (!hasAliases) {
        aliasRows = await CreatorAlias.findAll({
          where: { creatorId: id },
          attributes: ['id', 'name'],
          order: [['id', 'ASC']],
        });
      }

      const fresh = await Creator.findByPk(id, {
        attributes: ['id', 'name', 'verificationStatus', 'uploadConditions'],
      });

      return res.json({
        id,
        name: fresh?.name ?? nextName,
        verificationStatus: (fresh?.verificationStatus ?? 'allowed') as CreatorVerificationStatus,
        uploadConditions:
          typeof fresh?.uploadConditions === 'string' && fresh.uploadConditions.trim().length
            ? fresh.uploadConditions.trim()
            : null,
        aliases: aliasRows.map((a) => ({ id: a.id, name: a.name })),
        creatorAliases: aliasRows.map((a) => ({ name: a.name })),
      });
    } catch (error) {
      await transaction.rollback();
      logger.error('[v3 PATCH /creators/:id/managed-update] failure', error);
      return res.status(500).json({
        error: 'Failed to update creator',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

router.patch(
  '/:id([0-9]{1,20})/banner-preset',
  Auth.user(),
  ApiDoc({
    operationId: 'v3PatchCreatorBannerPreset',
    summary: 'Update creator profile banner preset',
    tags: ['Database', 'Creators', 'v3'],
    params: { id: idParamSpec },
    responses: {
      200: { description: 'Updated banner preset' },
      ...standardErrorResponses404500,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const user = req.user!;
      const id = resolveOwnCreatorRouteId(req, res, user);
      if (id === null) return;

      const body = req.body as { preset?: unknown };
      if (!Object.prototype.hasOwnProperty.call(body, 'preset')) {
        return res.status(400).json({ error: 'Request body must include preset (string or null)' });
      }
      let preset: string | null;
      try {
        preset = parseBannerPresetForStorage(body?.preset);
      } catch {
        return res.status(400).json({ error: 'Invalid banner preset' });
      }

      const result = await setBannerPresetForEntity('creator', id, preset);
      await invalidateLinkedUserForCreator(id);

      return res.json(result);
    } catch (error) {
      logger.error('[v3 PATCH /creators/:id/banner-preset] failure', error);
      return res.status(500).json({
        error: 'Failed to update creator banner preset',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

router.delete(
  '/:id([0-9]{1,20})/banner-preset',
  Auth.user(),
  ApiDoc({
    operationId: 'v3DeleteCreatorBannerPreset',
    summary: 'Clear creator profile banner preset',
    tags: ['Database', 'Creators', 'v3'],
    params: { id: idParamSpec },
    responses: {
      200: { description: 'Cleared banner preset' },
      ...standardErrorResponses404500,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const user = req.user!;
      const id = resolveOwnCreatorRouteId(req, res, user);
      if (id === null) return;

      const result = await clearBannerPresetForEntity('creator', id);
      await invalidateLinkedUserForCreator(id);

      return res.json(result);
    } catch (error) {
      logger.error('[v3 DELETE /creators/:id/banner-preset] failure', error);
      return res.status(500).json({
        error: 'Failed to clear creator banner preset',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

router.patch(
  '/:id([0-9]{1,20})/tuf-stellar-icon-variant',
  Auth.tufStellarUser(),
  ApiDoc({
    operationId: 'v3PatchCreatorTufStellarIconVariant',
    summary: 'Update creator TUFStellar icon variant (v3)',
    description:
      'Active TUFStellar subscription required. Linked creator profile only. Body: `{ variant: "1" | "2" | "3" }`.',
    tags: ['Database', 'Creators', 'v3'],
    security: ['bearerAuth'],
    params: { id: idParamSpec },
    requestBody: {
      required: true,
      schema: {
        type: 'object',
        properties: {
          variant: { type: 'string', enum: ['1', '2', '3'] },
        },
        required: ['variant'],
      },
    },
    responses: {
      200: { description: 'Updated variant' },
      ...standardErrorResponses404500,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const user = req.user!;
      if (!isTufStellarFeatureEnabled()) {
        return res.status(403).json({ error: 'TUFStellar is not available on this deployment' });
      }
      const id = resolveOwnCreatorRouteId(req, res, user);
      if (id === null) return;

      const body = req.body as { variant?: unknown };
      if (!Object.prototype.hasOwnProperty.call(body, 'variant')) {
        return res.status(400).json({ error: 'Request body must include variant' });
      }
      const rawVariant = body.variant;
      if (typeof rawVariant !== 'string' || !['1', '2', '3'].includes(rawVariant.trim())) {
        return res.status(400).json({ error: 'variant must be "1", "2", or "3"' });
      }
      const next = normalizeTufStellarIconVariant(rawVariant);

      const result = await setStellarIconVariantForEntity('creator', id, next);
      await invalidateLinkedUserForCreator(id);

      return res.json(result);
    } catch (error) {
      logger.error('[v3 PATCH /creators/:id/tuf-stellar-icon-variant] failure', error);
      return res.status(500).json({
        error: 'Failed to update TUFStellar icon variant',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

router.post(
  '/:id([0-9]{1,20})/banner-custom',
  Auth.tufStellarUser(),
  bannerUpload.single('banner'),
  ApiDoc({
    operationId: 'v3PostCreatorBannerCustom',
    summary: 'Upload creator custom profile banner',
    tags: ['Database', 'Creators', 'v3'],
    params: { id: idParamSpec },
    responses: {
      200: { description: 'Uploaded custom banner' },
      ...standardErrorResponses404500,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      if (!CUSTOM_PROFILE_BANNERS_ENABLED) {
        return res.status(403).json({ error: 'Custom profile banners are temporarily disabled' });
      }
      const user = req.user!;
      const id = resolveOwnCreatorRouteId(req, res, user);
      if (id === null) return;

      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded', code: 'NO_FILE' });
      }

      const uploaded = await uploadCustomBannerForEntity('creator', id, req.file);
      await invalidateLinkedUserForCreator(id);

      return res.json(uploaded);
    } catch (error) {
      if (error instanceof CdnError) {
        return res.status(400).json({
          error: error.message,
          code: error.code,
          details: error.details,
        });
      }
      logger.error('[v3 POST /creators/:id/banner-custom] failure', error);
      return res.status(500).json({
        error: 'Failed to upload creator banner',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

router.delete(
  '/:id([0-9]{1,20})/banner-custom',
  Auth.tufStellarUser(),
  ApiDoc({
    operationId: 'v3DeleteCreatorBannerCustom',
    summary: 'Remove creator custom profile banner',
    tags: ['Database', 'Creators', 'v3'],
    params: { id: idParamSpec },
    responses: {
      200: { description: 'Removed custom banner' },
      ...standardErrorResponses404500,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      if (!CUSTOM_PROFILE_BANNERS_ENABLED) {
        return res.status(403).json({ error: 'Custom profile banners are temporarily disabled' });
      }
      const user = req.user!;
      const id = resolveOwnCreatorRouteId(req, res, user);
      if (id === null) return;

      const cleared = await clearCustomBannerForEntity('creator', id);
      await invalidateLinkedUserForCreator(id);

      return res.json(cleared);
    } catch (error) {
      logger.error('[v3 DELETE /creators/:id/banner-custom] failure', error);
      return res.status(500).json({
        error: 'Failed to remove creator custom banner',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

router.patch(
  '/:id([0-9]{1,20})/header-surface-style',
  Auth.tufStellarUser(),
  ApiDoc({
    operationId: 'v3PatchCreatorHeaderSurfaceStyle',
    summary: 'Update creator profile header card surface style',
    tags: ['Database', 'Creators', 'v3'],
    params: { id: idParamSpec },
    responses: {
      200: { description: 'Updated header surface style' },
      ...standardErrorResponses404500,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      if (!CUSTOM_PROFILE_BANNERS_ENABLED) {
        return res.status(403).json({ error: 'Profile header customization is temporarily disabled' });
      }
      const user = req.user!;
      const id = resolveOwnCreatorRouteId(req, res, user);
      if (id === null) return;

      const body = req.body as { style?: unknown };
      if (!Object.prototype.hasOwnProperty.call(body, 'style')) {
        return res.status(400).json({ error: 'Request body must include style (object or null)' });
      }

      let parsed: ProfileHeaderSurfaceStyle | null;
      try {
        parsed = parseProfileHeaderSurfaceStyle(body.style);
      } catch (err) {
        const msg =
          err instanceof ProfileHeaderSurfaceStyleError ? err.message : 'Invalid header surface style';
        return res.status(400).json({ error: msg });
      }

      const updated = await patchHeaderSurfaceStyleForEntity('creator', id, parsed);
      await invalidateLinkedUserForCreator(id);

      return res.json(updated);
    } catch (error) {
      logger.error('[v3 PATCH /creators/:id/header-surface-style] failure', error);
      return res.status(500).json({
        error: 'Failed to update header surface style',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

router.post(
  '/:id([0-9]{1,20})/header-surface-image',
  Auth.tufStellarUser(),
  bannerUpload.single('image'),
  ApiDoc({
    operationId: 'v3PostCreatorHeaderSurfaceImage',
    summary: 'Upload creator profile header surface background image',
    tags: ['Database', 'Creators', 'v3'],
    params: { id: idParamSpec },
    responses: {
      200: { description: 'Uploaded header surface image' },
      ...standardErrorResponses404500,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      if (!CUSTOM_PROFILE_BANNERS_ENABLED) {
        return res.status(403).json({ error: 'Profile header customization is temporarily disabled' });
      }
      const user = req.user!;
      const id = resolveOwnCreatorRouteId(req, res, user);
      if (id === null) return;

      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded', code: 'NO_FILE' });
      }

      const layerId = parseHeaderSurfaceLayerId(req);
      if (!layerId) {
        return res.status(400).json({ error: 'layerId is required' });
      }

      try {
        const uploaded = await uploadHeaderSurfaceImageForEntity('creator', id, layerId, req.file);
        await invalidateLinkedUserForCreator(id);
        return res.json({ layerId, ...uploaded });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to upload header surface image';
        if (msg.includes('layerId') || msg.includes('Save header surface')) {
          return res.status(400).json({ error: msg });
        }
        throw err;
      }
    } catch (error) {
      if (error instanceof CdnError) {
        return res.status(400).json({
          error: error.message,
          code: error.code,
          details: error.details,
        });
      }
      logger.error('[v3 POST /creators/:id/header-surface-image] failure', error);
      return res.status(500).json({
        error: 'Failed to upload header surface image',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

router.delete(
  '/:id([0-9]{1,20})/header-surface-image',
  Auth.tufStellarUser(),
  ApiDoc({
    operationId: 'v3DeleteCreatorHeaderSurfaceImage',
    summary: 'Remove creator profile header surface background image',
    tags: ['Database', 'Creators', 'v3'],
    params: { id: idParamSpec },
    responses: {
      200: { description: 'Removed header surface image' },
      ...standardErrorResponses404500,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      if (!CUSTOM_PROFILE_BANNERS_ENABLED) {
        return res.status(403).json({ error: 'Profile header customization is temporarily disabled' });
      }
      const user = req.user!;
      const id = resolveOwnCreatorRouteId(req, res, user);
      if (id === null) return;

      const layerId = parseHeaderSurfaceLayerId(req);
      if (!layerId) {
        return res.status(400).json({ error: 'layerId is required' });
      }

      const removed = await deleteHeaderSurfaceImageForEntity('creator', id, layerId);
      await invalidateLinkedUserForCreator(id);

      return res.json({ layerId, ...removed });
    } catch (error) {
      logger.error('[v3 DELETE /creators/:id/header-surface-image] failure', error);
      return res.status(500).json({
        error: 'Failed to remove header surface image',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

router.patch(
  '/me/placement-display',
  Auth.user(),
  async (req: Request, res: Response) => {
    try {
      const user = req.user;
      if (!user?.creatorId) {
        return res.status(400).json({error: 'No creator profile linked to this account'});
      }
      const prefs =
        await PlacementUtilizationService.getInstance().setPlacementDisplayPrefs(
          {creatorId: user.creatorId},
          {
            cardLayout: req.body.cardLayout,
            placementDisplayMode: req.body.placementDisplayMode,
            placementOrderIds: req.body.placementOrderIds,
            hiddenPlacementIds: req.body.hiddenPlacementIds,
            placementDisplayNodes: req.body.placementDisplayNodes,
          },
        );
      return res.json(prefs);
    } catch (error) {
      logger.error('[v3 PATCH /creators/me/placement-display] failure', error);
      return res.status(500).json({error: 'Failed to update placement display'});
    }
  },
);

router.patch(
  '/me/equipped-cosmetic',
  Auth.user(),
  async (req: Request, res: Response) => {
    try {
      const user = req.user;
      if (!user?.creatorId) {
        return res.status(400).json({error: 'No creator profile linked to this account'});
      }
      const rewardType = String(req.body.rewardType || 'avatar_frame');
      const entitlementId =
        req.body.entitlementId == null ? null : Number(req.body.entitlementId);
      if (entitlementId != null && !Number.isFinite(entitlementId)) {
        return res.status(400).json({error: 'Invalid entitlementId'});
      }
      const equipped = await PlacementUtilizationService.getInstance().equipCosmetic(
        {creatorId: user.creatorId},
        rewardType,
        entitlementId,
      );
      return res.json(equipped);
    } catch (error: any) {
      if (error?.code === 404) return res.status(404).json({error: error.message});
      if (error?.code === 403) return res.status(403).json({error: error.message});
      if (error?.code === 400) return res.status(400).json({error: error.message});
      logger.error('[v3 PATCH /creators/me/equipped-cosmetic] failure', error);
      return res.status(500).json({error: 'Failed to equip cosmetic'});
    }
  },
);

router.get(
  '/me/placement-entitlements',
  Auth.user(),
  async (req: Request, res: Response) => {
    try {
      const user = req.user;
      if (!user?.creatorId) {
        return res.status(400).json({error: 'No creator profile linked to this account'});
      }
      const rewardType =
        typeof req.query.rewardType === 'string' ? req.query.rewardType : undefined;
      const entitlements = await PlacementUtilizationService.getInstance().listEntitlements(
        {creatorId: user.creatorId},
        {rewardType},
      );
      const equipped = await PlacementUtilizationService.getInstance().getEquippedCosmetic(
        {creatorId: user.creatorId},
        rewardType || 'avatar_frame',
      );
      return res.json({entitlements, equipped});
    } catch (error) {
      logger.error('[v3 GET /creators/me/placement-entitlements] failure', error);
      return res.status(500).json({error: 'Failed to list entitlements'});
    }
  },
);

export default router;

