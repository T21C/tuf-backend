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
import { hasFlag, type PermissionInput } from '@/misc/utils/auth/permissionUtils.js';
import { CUSTOM_PROFILE_BANNERS_ENABLED } from '@/config/env.js';
import { multerMemoryCdnImage10Mb as bannerUpload } from '@/config/multerMemoryUploads.js';
import cdnService from '@/server/services/core/CdnService.js';
import { CdnError } from '@/server/services/core/CdnService.js';
import { parseBannerPresetForStorage } from '@/misc/utils/profileBannerPreset.js';
import { CacheInvalidation } from '@/server/middleware/cache.js';
import User from '@/models/auth/User.js';

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

router.get(
  '/search',
  ApiDoc({
    operationId: 'v3GetCreatorsSearch',
    summary: 'Search creators (v3)',
    description:
      'Elasticsearch-backed creator search. Accepts text or `@username` via the `query` param. Returns a flat list sorted by relevance.',
    tags: ['Database', 'Creators', 'v3'],
    query: {
      query: { schema: { type: 'string' } },
      limit: { schema: { type: 'string' } },
      offset: { schema: { type: 'string' } },
      filters: { schema: { type: 'string' } },
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

      const options: CreatorSearchOptions = {
        rawQuery: query || undefined,
        filters,
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
      'Elasticsearch-backed creator leaderboard. Supports sort, numeric range filters, verificationStatus filter (single value or array), and text/`@username` query. Returns `maxFields` aggregations for UI filter ceilings.',
    tags: ['Database', 'Creators', 'v3'],
    query: {
      sortBy: { schema: { type: 'string' } },
      order: { schema: { type: 'string' } },
      query: { schema: { type: 'string' } },
      offset: { schema: { type: 'string' } },
      limit: { schema: { type: 'string' } },
      filters: { schema: { type: 'string' } },
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

      if (!validCreatorSortOptions.includes(sortBy)) {
        return res.status(400).json({
          error: `Invalid sortBy option. Valid options are: ${validCreatorSortOptions.join(', ')}`,
        });
      }

      const effectiveLimit = parseLimit(limit);
      const effectiveOffset = parseOffset(offset);

      const options: CreatorSearchOptions = {
        rawQuery,
        sortBy,
        order: order === 'asc' ? 'asc' : 'desc',
        filters,
        limit: effectiveLimit,
        offset: effectiveOffset,
        requireHasCharts: !rawQuery,
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

      await Creator.update({name: rawName}, {where: {id}});
      // Elasticsearch: CDC projectors (`creators` → indexCreator + level fanout on name change).

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
      // Elasticsearch: CDC projectors (`creator_aliases` → indexCreator).

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

      const exists = await Creator.findByPk(id, { attributes: ['id'] });
      if (!exists) {
        return res.status(404).json({ error: 'Creator not found' });
      }

      await Creator.update({ bio: nextBio }, { where: { id } });
      await elasticsearchService.reindexCreators([id]);
      await invalidateLinkedUserForCreator(id);

      return res.json({ bio: nextBio });
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

      const [doc, enriched, funFacts, curationTypeCounts, creatorRow] = await Promise.all([
        elasticsearchService.getCreatorDocumentById(id),
        creatorStatsService.getEnrichedCreator(id),
        computeCreatorFunFacts(id),
        computeCreatorCurationTypeCounts(id),
        Creator.findByPk(id, {
          attributes: [
            'id',
            'bio',
            'uploadConditions',
            'displayCurationTypeIds',
            'bannerPreset',
            'customBannerId',
            'customBannerUrl',
          ],
        }),
      ]);

      if (!doc && !enriched) return res.status(404).json({ error: 'Creator not found' });

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
                  }
                : null,
              bannerPreset: enriched.creator?.bannerPreset ?? null,
              customBannerId: enriched.creator?.customBannerId ?? null,
              customBannerUrl: enriched.creator?.customBannerUrl ?? null,
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

      const bannerFromRow = creatorRow
        ? {
            bio: typeof creatorRow.bio === 'string' && creatorRow.bio.trim().length ? creatorRow.bio : null,
            uploadConditions:
              typeof creatorRow.uploadConditions === 'string' &&
              creatorRow.uploadConditions.trim().length
                ? creatorRow.uploadConditions.trim()
                : null,
            bannerPreset: creatorRow.bannerPreset ?? null,
            customBannerId: creatorRow.customBannerId ?? null,
            customBannerUrl: creatorRow.customBannerUrl ?? null,
          }
        : {};

      return res.json({
        ...(responseDoc as Record<string, unknown>),
        ...bannerFromRow,
        aliases,
        creatorAliases,
        recentLevelIds,
        funFacts,
        curationTypeCounts,
        displayCurationTypeIds,
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

function isCreatorBannerActor(user: PermissionInput, creatorId: number): boolean {
  const u = user as { creatorId?: number | string | null };
  const isOwner = u.creatorId != null && Number(u.creatorId) === creatorId;
  return (
    isOwner ||
    hasFlag(user, permissionFlags.SUPER_ADMIN) ||
    hasFlag(user, permissionFlags.HEAD_CURATOR)
  );
}

function canUploadCreatorCustomBanner(user: PermissionInput): boolean {
  return (
    hasFlag(user, permissionFlags.CUSTOM_PROFILE_BANNER) ||
    hasFlag(user, permissionFlags.SUPER_ADMIN) ||
    hasFlag(user, permissionFlags.HEAD_CURATOR)
  );
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
  Auth.addUserToRequest(),
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
      const user = req.user;
      if (!user?.id) return res.status(401).json({ error: 'Unauthorized' });
      const permUser = user as PermissionInput;

      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid creator id' });
      }
      if (!isCreatorBannerActor(permUser, id)) {
        return res.status(403).json({ error: 'Forbidden' });
      }

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

      const exists = await Creator.findByPk(id, { attributes: ['id'] });
      if (!exists) return res.status(404).json({ error: 'Creator not found' });

      await Creator.update({ bannerPreset: preset }, { where: { id } });
      await elasticsearchService.reindexCreators([id]);
      await invalidateLinkedUserForCreator(id);

      return res.json({ bannerPreset: preset });
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
  Auth.addUserToRequest(),
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
      const user = req.user;
      if (!user?.id) return res.status(401).json({ error: 'Unauthorized' });
      const permUser = user as PermissionInput;

      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid creator id' });
      }
      if (!isCreatorBannerActor(permUser, id)) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      const exists = await Creator.findByPk(id, { attributes: ['id'] });
      if (!exists) return res.status(404).json({ error: 'Creator not found' });

      await Creator.update({ bannerPreset: null }, { where: { id } });
      await elasticsearchService.reindexCreators([id]);
      await invalidateLinkedUserForCreator(id);

      return res.json({ bannerPreset: null });
    } catch (error) {
      logger.error('[v3 DELETE /creators/:id/banner-preset] failure', error);
      return res.status(500).json({
        error: 'Failed to clear creator banner preset',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

router.post(
  '/:id([0-9]{1,20})/banner-custom',
  Auth.addUserToRequest(),
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
      const user = req.user;
      if (!user?.id) return res.status(401).json({ error: 'Unauthorized' });
      const permUser = user as PermissionInput;

      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid creator id' });
      }
      if (!isCreatorBannerActor(permUser, id)) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      if (!canUploadCreatorCustomBanner(permUser)) {
        return res.status(403).json({ error: 'Custom profile banners are not enabled for this account' });
      }

      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded', code: 'NO_FILE' });
      }

      const creator = await Creator.findByPk(id);
      if (!creator) return res.status(404).json({ error: 'Creator not found' });

      const result = await cdnService.uploadImage(req.file.buffer, req.file.originalname, 'BANNER');
      const displayUrl = result.urls?.large ?? result.urls?.original ?? null;
      if (!displayUrl) {
        return res.status(500).json({ error: 'CDN did not return banner URLs' });
      }

      const oldId = creator.customBannerId;
      await Creator.update(
        { customBannerId: result.fileId, customBannerUrl: displayUrl },
        { where: { id } },
      );

      if (oldId && oldId !== result.fileId) {
        try {
          if (await cdnService.checkFileExists(oldId)) {
            await cdnService.deleteFile(oldId);
          }
        } catch (delErr) {
          logger.error('[v3 POST /creators/:id/banner-custom] failed deleting previous banner file', delErr);
        }
      }

      await elasticsearchService.reindexCreators([id]);
      await invalidateLinkedUserForCreator(id);

      return res.json({
        customBannerId: result.fileId,
        customBannerUrl: displayUrl,
      });
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
  Auth.addUserToRequest(),
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
      const user = req.user;
      if (!user?.id) return res.status(401).json({ error: 'Unauthorized' });
      const permUser = user as PermissionInput;

      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid creator id' });
      }
      if (!isCreatorBannerActor(permUser, id)) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      if (!canUploadCreatorCustomBanner(permUser)) {
        return res.status(403).json({ error: 'Custom profile banners are not enabled for this account' });
      }

      const creator = await Creator.findByPk(id);
      if (!creator) return res.status(404).json({ error: 'Creator not found' });

      const oldId = creator.customBannerId;
      await Creator.update({ customBannerId: null, customBannerUrl: null }, { where: { id } });

      if (oldId) {
        try {
          if (await cdnService.checkFileExists(oldId)) {
            await cdnService.deleteFile(oldId);
          }
        } catch (delErr) {
          logger.error('[v3 DELETE /creators/:id/banner-custom] failed deleting CDN file', delErr);
        }
      }

      await elasticsearchService.reindexCreators([id]);
      await invalidateLinkedUserForCreator(id);

      return res.json({ customBannerId: null, customBannerUrl: null });
    } catch (error) {
      logger.error('[v3 DELETE /creators/:id/banner-custom] failure', error);
      return res.status(500).json({
        error: 'Failed to remove creator custom banner',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

export default router;
