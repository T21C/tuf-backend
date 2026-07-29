import {Router, Request, Response} from 'express';
import {Auth} from '@/server/middleware/auth.js';
import {ApiDoc} from '@/server/middleware/apiDoc.js';
import {
  errorResponseSchema,
  idParamSpec,
  standardErrorResponses,
  standardErrorResponses404500,
  standardErrorResponses500,
} from '@/server/schemas/common.js';
import sequelize from '@/config/db.js';
import {safeTransactionRollback} from '@/misc/utils/Utility.js';
import {logger} from '@/server/services/core/LoggerService.js';
import {
  createTeam,
  deleteTeam,
  listTeams,
  loadTeamFlat,
  searchTeams,
  TeamMutationError,
  updateTeam,
} from '@/server/services/teams/teamMutations.js';

const router: Router = Router();

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

function parseLimit(raw: unknown, fallback = DEFAULT_LIMIT): number {
  const n = typeof raw === 'string' ? parseInt(raw, 10) : typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_LIMIT, Math.max(1, n));
}

function parseOffset(raw: unknown): number {
  const n = typeof raw === 'string' ? parseInt(raw, 10) : typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

function handleTeamError(res: Response, error: unknown, logLabel: string) {
  if (error instanceof TeamMutationError) {
    return res.status(error.status).json({error: error.message, ...error.extra});
  }
  logger.error(logLabel, error);
  return res.status(500).json({
    error: 'Failed to process team request',
    details: error instanceof Error ? error.message : String(error),
  });
}

router.get(
  '/search',
  ApiDoc({
    operationId: 'v3GetTeamsSearch',
    summary: 'Search teams (v3)',
    description: 'Search teams by name or alias. Query: query, limit, offset.',
    tags: ['Database', 'Teams', 'v3'],
    query: {
      query: {schema: {type: 'string'}},
      limit: {schema: {type: 'string'}},
      offset: {schema: {type: 'string'}},
    },
    responses: {200: {description: 'Paginated teams'}, ...standardErrorResponses500},
  }),
  async (req: Request, res: Response) => {
    try {
      const limit = parseLimit(req.query.limit);
      const offset = parseOffset(req.query.offset);
      const query = typeof req.query.query === 'string' ? req.query.query : '';
      const {total, results} = await searchTeams({query, limit, offset});
      return res.json({total, results, limit, offset});
    } catch (error) {
      return handleTeamError(res, error, '[v3 GET /teams/search] failure');
    }
  },
);

router.get(
  '/',
  ApiDoc({
    operationId: 'v3GetTeams',
    summary: 'List teams (v3)',
    description:
      'List teams with optional search. Query: search, limit, offset. Prefer /search for paginated search.',
    tags: ['Database', 'Teams', 'v3'],
    query: {
      search: {schema: {type: 'string'}},
      limit: {schema: {type: 'string'}},
      offset: {schema: {type: 'string'}},
    },
    responses: {200: {description: 'Teams list'}, ...standardErrorResponses500},
  }),
  async (req: Request, res: Response) => {
    try {
      const search = typeof req.query.search === 'string' ? req.query.search : undefined;
      const hasPaging = req.query.limit != null || req.query.offset != null;
      if (hasPaging) {
        const limit = parseLimit(req.query.limit);
        const offset = parseOffset(req.query.offset);
        const {total, results} = await searchTeams({query: search, limit, offset});
        return res.json({total, results, limit, offset});
      }
      const results = await listTeams(search);
      return res.json({total: results.length, results, limit: results.length, offset: 0});
    } catch (error) {
      return handleTeamError(res, error, '[v3 GET /teams] failure');
    }
  },
);

router.get(
  '/:id([0-9]{1,20})',
  ApiDoc({
    operationId: 'v3GetTeam',
    summary: 'Get team (v3)',
    description: 'Get team by ID with members and aliases.',
    tags: ['Database', 'Teams', 'v3'],
    params: {id: idParamSpec},
    responses: {200: {description: 'Team'}, ...standardErrorResponses404500},
  }),
  async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({error: 'Invalid team id'});
      }
      const includeLevels = req.query.includeLevels === 'true';
      const team = await loadTeamFlat(id, {includeLevels});
      if (!team) {
        return res.status(404).json({error: 'Team not found'});
      }
      return res.json(team);
    } catch (error) {
      return handleTeamError(res, error, '[v3 GET /teams/:id] failure');
    }
  },
);

router.post(
  '/',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'v3PostTeam',
    summary: 'Create team (v3)',
    description: 'Create team. Body: name, aliases?, description?. Super admin.',
    tags: ['Database', 'Teams', 'v3'],
    security: ['bearerAuth'],
    requestBody: {
      description: 'name, aliases, description',
      schema: {
        type: 'object',
        properties: {
          name: {type: 'string'},
          aliases: {type: 'array', items: {type: 'string'}},
          description: {type: 'string'},
        },
        required: ['name'],
      },
      required: true,
    },
    responses: {
      200: {description: 'Team created'},
      400: {schema: errorResponseSchema},
      ...standardErrorResponses500,
    },
  }),
  async (req: Request, res: Response) => {
    let transaction: Awaited<ReturnType<typeof sequelize.transaction>> | undefined;
    try {
      transaction = await sequelize.transaction();
      const team = await createTeam(
        {
          name: req.body?.name,
          aliases: req.body?.aliases,
          description: req.body?.description,
        },
        transaction,
      );
      await transaction.commit();
      return res.json({...team, type: 'team'});
    } catch (error) {
      await safeTransactionRollback(transaction);
      return handleTeamError(res, error, '[v3 POST /teams] failure');
    }
  },
);

router.patch(
  '/:id([0-9]{1,20})',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'v3PatchTeam',
    summary: 'Update team (v3)',
    description: 'Partial update. Body: name?, aliases?, description?. Super admin.',
    tags: ['Database', 'Teams', 'v3'],
    security: ['bearerAuth'],
    params: {id: idParamSpec},
    requestBody: {
      description: 'name, aliases, description',
      schema: {
        type: 'object',
        properties: {
          name: {type: 'string'},
          aliases: {type: 'array', items: {type: 'string'}},
          description: {type: 'string'},
        },
      },
      required: true,
    },
    responses: {200: {description: 'Team updated'}, ...standardErrorResponses},
  }),
  async (req: Request, res: Response) => {
    let transaction: Awaited<ReturnType<typeof sequelize.transaction>> | undefined;
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({error: 'Invalid team id'});
      }
      transaction = await sequelize.transaction();
      const team = await updateTeam(
        id,
        {
          name: req.body?.name,
          aliases: req.body?.aliases,
          description: req.body?.description,
        },
        transaction,
      );
      await transaction.commit();
      return res.json(team);
    } catch (error) {
      await safeTransactionRollback(transaction);
      return handleTeamError(res, error, '[v3 PATCH /teams/:id] failure');
    }
  },
);

router.delete(
  '/:id([0-9]{1,20})',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'v3DeleteTeam',
    summary: 'Delete team (v3)',
    description: 'Delete team if not assigned to any levels. Super admin.',
    tags: ['Database', 'Teams', 'v3'],
    security: ['bearerAuth'],
    params: {id: idParamSpec},
    responses: {200: {description: 'Team deleted'}, ...standardErrorResponses},
  }),
  async (req: Request, res: Response) => {
    let transaction: Awaited<ReturnType<typeof sequelize.transaction>> | undefined;
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({error: 'Invalid team id'});
      }
      transaction = await sequelize.transaction();
      await deleteTeam(id, transaction);
      await transaction.commit();
      return res.json({message: 'Team deleted successfully'});
    } catch (error) {
      await safeTransactionRollback(transaction);
      return handleTeamError(res, error, '[v3 DELETE /teams/:id] failure');
    }
  },
);

export default router;
