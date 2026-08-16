// tuf-search: #mySubmissions #formSubmissions
import {Router, type Request, type Response} from 'express';
import {Auth} from '@/server/middleware/auth.js';
import {ApiDoc} from '@/server/middleware/apiDoc.js';
import {
  standardErrorResponses401500,
} from '@/server/schemas/common.js';
import {logger} from '@/server/services/core/LoggerService.js';
import {PaginationQuery} from '@/server/interfaces/models/index.js';
import {
  listMySubmissions,
  type SubmissionSort,
  type SubmissionStatus,
  type SubmissionTypeFilter,
} from './listService.js';

const router: Router = Router();

const MAX_LIMIT = 50;

const TYPE_VALUES = new Set<SubmissionTypeFilter>(['all', 'pass', 'level']);
const STATUS_VALUES = new Set<SubmissionStatus>(['pending', 'approved', 'declined']);
const SORT_VALUES = new Set<SubmissionSort>(['DATE_DESC', 'DATE_ASC', 'STATUS', 'TYPE']);

function parseType(value: unknown): SubmissionTypeFilter {
  const raw = typeof value === 'string' ? value.trim() : '';
  return TYPE_VALUES.has(raw as SubmissionTypeFilter)
    ? (raw as SubmissionTypeFilter)
    : 'all';
}

function parseStatus(value: unknown): SubmissionStatus | null {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw || raw === 'all') return null;
  return STATUS_VALUES.has(raw as SubmissionStatus) ? (raw as SubmissionStatus) : null;
}

function parseSort(value: unknown): SubmissionSort {
  const raw = typeof value === 'string' ? value.trim() : '';
  return SORT_VALUES.has(raw as SubmissionSort) ? (raw as SubmissionSort) : 'DATE_DESC';
}

function parseQuery(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

router.get(
  '/',
  Auth.user(),
  ApiDoc({
    operationId: 'getMySubmissions',
    summary: 'List the authenticated user\'s submissions',
    description:
      'Paginated pass and chart submissions for the current user. Query: type (all|pass|level), status (all|pending|approved|declined), query, sort (DATE_DESC|DATE_ASC|STATUS|TYPE), page, offset, limit.',
    tags: ['Form'],
    security: ['bearerAuth'],
    query: {
      type: {schema: {type: 'string'}, description: 'all (default), pass, or level'},
      status: {schema: {type: 'string'}, description: 'all (default), pending, approved, or declined'},
      query: {schema: {type: 'string'}, description: 'Search song, artist, charter, passer, video link, or id'},
      sort: {schema: {type: 'string'}, description: 'DATE_DESC (default), DATE_ASC, STATUS, or TYPE'},
      page: {schema: {type: 'string'}},
      offset: {schema: {type: 'string'}},
      limit: {schema: {type: 'string'}},
    },
    responses: {
      200: {
        description: 'Paginated submissions',
        schema: {
          type: 'object',
          properties: {
            results: {type: 'array', items: {type: 'object'}},
            total: {type: 'integer'},
            page: {type: 'integer'},
            limit: {type: 'integer'},
            offset: {type: 'integer'},
          },
        },
      },
      ...standardErrorResponses401500,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({error: 'User not authenticated'});

      const {page, limit: rawLimit} = req.query as unknown as PaginationQuery;
      const limit = Math.min(rawLimit, MAX_LIMIT);
      const offset = (page - 1) * limit;

      const result = await listMySubmissions({
        userId,
        type: parseType(req.query.type),
        status: parseStatus(req.query.status),
        query: parseQuery(req.query.query),
        sort: parseSort(req.query.sort),
        page,
        limit,
        offset,
      });
      return res.json(result);
    } catch (error) {
      logger.error('Error listing user submissions:', error);
      return res.status(500).json({error: 'Failed to list submissions'});
    }
  },
);

export default router;
