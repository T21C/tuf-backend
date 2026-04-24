import { Router, Request, Response } from 'express';
import { ApiDoc } from '@/server/middleware/apiDoc.js';
import {
  idParamSpec,
  errorResponseSchema,
  standardErrorResponses404500,
  standardErrorResponses500,
} from '@/server/schemas/common.js';
import { validCreatorSortOptions } from '@/config/constants.js';
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
import { permissionFlags } from '@/config/constants.js';

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
        Creator.findByPk(id, {attributes: ['id', 'displayCurationTypeIds']}),
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
                  }
                : null,
              chartsCreated: enriched.stats.chartsCreated,
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
              }
            : ((doc as { user?: unknown }).user ?? null),
        };
      }

      const recentLevelIds = enriched?.recentLevelIds ?? [];

      const rawDisplay = creatorRow?.get?.('displayCurationTypeIds') ?? creatorRow?.displayCurationTypeIds;
      const displayCurationTypeIds = Array.isArray(rawDisplay)
        ? rawDisplay
            .map((x: unknown) => Number(x))
            .filter((n: number) => Number.isFinite(n))
            .slice(0, 5)
        : [];

      return res.json({
        ...responseDoc,
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

export default router;
