import { Router, Request, Response } from 'express';
import { Op } from 'sequelize';
import { Auth } from '@/server/middleware/auth.js';
import { ApiDoc } from '@/server/middleware/apiDoc.js';
import { logger } from '@/server/services/core/LoggerService.js';
import {
  standardErrorResponses401500,
} from '@/server/schemas/common.js';
import { User } from '@/models/index.js';
import ElasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';
import {
  grantAccess,
  listGrants,
  retractGrant,
  TufStellarAdminGrantError,
} from '@/server/services/billing/tufStellarAdminGrants.js';
import type { AdminGrantDurationKind } from '@/server/services/billing/tufStellarEntitlementSegments.js';

const router: Router = Router();

const BILLING_RECIPIENT_ES_LIMIT = 40;
const BILLING_RECIPIENT_RESPONSE_LIMIT = 15;

function grantErrorResponse(res: Response, e: unknown) {
  if (e instanceof TufStellarAdminGrantError) {
    const status =
      e.code === 'GRANT_NOT_FOUND'
        ? 404
        : e.code === 'BENEFICIARY_NOT_FOUND'
          ? 404
          : e.code === 'GRANT_ALREADY_RETRACTED' || e.code === 'BENEFICIARY_BLOCKED' || e.code === 'INVALID_DURATION'
            ? 400
            : 400;
    return res.status(status).json({
      error: { code: e.code, message: e.message },
    });
  }
  logger.error('TUFStellar admin grant error', e);
  return res.status(500).json({
    error: { code: 'SERVER_ERROR', message: 'Request failed.' },
  });
}

router.get(
  '/recipient-search',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'getTufStellarAdminGrantRecipientSearch',
    summary: 'Search accounts for admin grant beneficiary',
    description:
      'Elasticsearch player search for superadmin grants. Includes your own account; excludes banned/suspended accounts.',
    tags: ['Billing', 'Admin'],
    security: ['bearerAuth'],
    query: {
      q: { schema: { type: 'string' } },
    },
    responses: {
      200: { description: 'Matching users' },
      ...standardErrorResponses401500,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const tokenUser = req.user;
      if (!tokenUser) {
        return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Not authenticated' } });
      }

      const es = ElasticsearchService.getInstance();
      const { hits } = await es.searchPlayers({
        text: req.query.q as string,
        showBanned: 'hide',
        requireLinkedUser: true,
        limit: BILLING_RECIPIENT_ES_LIMIT,
        offset: 0,
      });

      const orderedUserIds: string[] = [];
      const seenUser = new Set<string>();
      for (const doc of hits as Array<{ user?: { id?: string | null } | null }>) {
        const uid = doc?.user?.id;
        if (typeof uid !== 'string' || uid.length === 0) continue;
        if (seenUser.has(uid)) continue;
        seenUser.add(uid);
        orderedUserIds.push(uid);
      }

      if (orderedUserIds.length === 0) {
        return res.json({ users: [] });
      }

      const rows = await User.findAll({
        where: {
          id: { [Op.in]: orderedUserIds },
          status: { [Op.notIn]: ['banned', 'suspended'] },
        },
        attributes: ['id', 'username', 'nickname', 'avatarUrl', 'playerId'],
      });

      const rank = new Map(orderedUserIds.map((id, idx) => [id, idx]));
      const sorted = [...rows].sort((a, b) => (rank.get(String(a.id)) ?? 999) - (rank.get(String(b.id)) ?? 999));
      const users = sorted.slice(0, BILLING_RECIPIENT_RESPONSE_LIMIT).map((u) => ({
        id: u.id,
        username: u.username ?? null,
        nickname: u.nickname ?? null,
        avatarUrl: u.avatarUrl ?? null,
        playerId: u.playerId != null && Number.isFinite(Number(u.playerId)) ? Number(u.playerId) : null,
      }));

      return res.json({ users });
    } catch (e) {
      logger.error('GET /v3/billing/admin/grants/recipient-search failed', e);
      return res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Search failed' } });
    }
  },
);

router.get(
  '/',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'getTufStellarAdminGrants',
    summary: 'List TUFStellar admin grants',
    description: 'Read-only log of superadmin-granted access. Super admin.',
    tags: ['Billing', 'Admin'],
    security: ['bearerAuth'],
    query: {
      q: { schema: { type: 'string' } },
      expired: { schema: { type: 'string', enum: ['true', 'false'] } },
      page: { schema: { type: 'string' } },
      limit: { schema: { type: 'string' } },
    },
    responses: {
      200: { description: 'Grant log rows' },
      ...standardErrorResponses401500,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const expiredRaw = req.query.expired;
      let expired: boolean | undefined;
      if (expiredRaw === 'true') expired = true;
      else if (expiredRaw === 'false') expired = false;

      const page = req.query.page != null ? Number(req.query.page) : 1;
      const limit = req.query.limit != null ? Number(req.query.limit) : 25;

      const result = await listGrants({
        q: typeof req.query.q === 'string' ? req.query.q : undefined,
        expired,
        page: Number.isFinite(page) ? page : 1,
        limit: Number.isFinite(limit) ? limit : 25,
      });

      return res.json(result);
    } catch (e) {
      return grantErrorResponse(res, e);
    }
  },
);

router.post(
  '/',
  Auth.superAdminPassword(),
  ApiDoc({
    operationId: 'postTufStellarAdminGrant',
    summary: 'Grant TUFStellar access (admin)',
    description: 'Super admin with password. Creates entitlement segment and audit log row.',
    tags: ['Billing', 'Admin'],
    security: ['bearerAuth'],
    requestBody: {
      required: true,
      schema: {
        type: 'object',
        required: ['beneficiaryUserId', 'durationKind', 'durationValue'],
        properties: {
          beneficiaryUserId: { type: 'string', format: 'uuid' },
          durationKind: { type: 'string', enum: ['months', 'days'] },
          durationValue: { type: 'integer' },
          note: { type: 'string', maxLength: 255 },
        },
      },
    },
    responses: {
      201: { description: 'Grant created' },
      ...standardErrorResponses401500,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const actor = req.user;
      if (!actor?.id) {
        return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Not authenticated' } });
      }

      const { beneficiaryUserId, durationKind, durationValue, note } = req.body as {
        beneficiaryUserId?: string;
        durationKind?: AdminGrantDurationKind;
        durationValue?: number;
        note?: string;
      };

      if (!beneficiaryUserId || typeof beneficiaryUserId !== 'string') {
        return res.status(400).json({
          error: { code: 'INVALID_BENEFICIARY', message: 'beneficiaryUserId is required.' },
        });
      }
      if (durationKind !== 'months' && durationKind !== 'days') {
        return res.status(400).json({
          error: { code: 'INVALID_DURATION', message: 'durationKind must be months or days.' },
        });
      }
      const value = Number(durationValue);
      if (!Number.isFinite(value)) {
        return res.status(400).json({
          error: { code: 'INVALID_DURATION', message: 'durationValue must be a number.' },
        });
      }

      const grant = await grantAccess({
        grantedByUserId: actor.id,
        beneficiaryUserId,
        durationKind,
        durationValue: value,
        note,
      });

      return res.status(201).json({ grant });
    } catch (e) {
      return grantErrorResponse(res, e);
    }
  },
);

router.post(
  '/:id/retract',
  Auth.superAdminPassword(),
  ApiDoc({
    operationId: 'postTufStellarAdminGrantRetract',
    summary: 'Retract TUFStellar admin grant',
    description: 'Removes the linked entitlement segment and marks the grant retracted. Super admin with password.',
    tags: ['Billing', 'Admin'],
    security: ['bearerAuth'],
    params: {
      id: { schema: { type: 'string' } },
    },
    responses: {
      200: { description: 'Grant retracted' },
      ...standardErrorResponses401500,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const actor = req.user;
      if (!actor?.id) {
        return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Not authenticated' } });
      }

      const grantId = Number(req.params.id);
      if (!Number.isFinite(grantId) || grantId <= 0) {
        return res.status(400).json({
          error: { code: 'INVALID_GRANT_ID', message: 'Invalid grant id.' },
        });
      }

      const grant = await retractGrant({
        grantId,
        retractedByUserId: actor.id,
      });

      return res.json({ grant });
    } catch (e) {
      return grantErrorResponse(res, e);
    }
  },
);

export default router;
