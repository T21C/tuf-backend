import { Router, Request, Response } from 'express';
import { Auth } from '@/server/middleware/auth.js';
import { ApiDoc } from '@/server/middleware/apiDoc.js';
import { standardErrorResponses500 } from '@/server/schemas/v2/admin/index.js';
import { AuditLog, User } from '@/models/index.js';
import { Op } from 'sequelize';
import { logger } from '@/server/services/core/LoggerService.js';

const router = Router();

const AUDIT_LOG_SORT_COLUMNS = new Set([
  'id',
  'createdAt',
  'updatedAt',
  'userId',
  'action',
  'route',
  'method',
]);

// GET /admin/audit-logs
router.get(
  '/',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'getAdminAuditLogs',
    summary: 'Audit logs',
    description: 'Paginated audit logs. Query: userId, action, method, route, startDate, endDate, q, page, pageSize, sort, order. Super admin.',
    tags: ['Admin', 'Audit'],
    security: ['bearerAuth'],
    query: { userId: { schema: { type: 'string' } }, action: { schema: { type: 'string' } }, method: { schema: { type: 'string' } }, route: { schema: { type: 'string' } }, startDate: { schema: { type: 'string' } }, endDate: { schema: { type: 'string' } }, q: { schema: { type: 'string' } }, page: { schema: { type: 'string' } }, pageSize: { schema: { type: 'string' } }, sort: { schema: { type: 'string' } }, order: { schema: { type: 'string' } } },
    responses: { 200: { description: 'Audit logs' }, ...standardErrorResponses500 },
  }),
  async (req: Request, res: Response) => {
  try {
    const {
      userId,
      action,
      method,
      route,
      startDate,
      endDate,
      q,
      page = 1,
      pageSize = 25,
      sort = 'createdAt',
      order = 'DESC',
    } = req.query;

    const where: any = {};
    if (userId) where.userId = userId;
    if (action) where.action = action;
    if (method) where.method = method;
    if (route) where.route = { [Op.like]: `%${route}%` };
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt[Op.gte] = new Date(startDate as string);
      if (endDate) where.createdAt[Op.lte] = new Date(endDate as string);
    }
    if (q) {
      where[Op.or] = [
        { payload: { [Op.like]: `%${q}%` } },
        { result: { [Op.like]: `%${q}%` } },
      ];
    }

    const offset = (Number(page) - 1) * Number(pageSize);
    const limit = Number(pageSize);

    const sortCol =
      typeof sort === 'string' && AUDIT_LOG_SORT_COLUMNS.has(sort) ? sort : 'createdAt';
    const orderUpper = typeof order === 'string' ? order.toUpperCase() : 'DESC';
    const orderDir = orderUpper === 'ASC' ? 'ASC' : 'DESC';

    const { rows, count } = await AuditLog.findAndCountAll({
      where,
      order: [[sortCol, orderDir]],
      offset,
      limit,
      include: [{ model: User, as: 'user', attributes: ['id', 'username', 'avatarUrl', 'nickname'] }],
    });

    res.json({
      total: count,
      page: Number(page),
      pageSize: Number(pageSize),
      logs: rows,
    });
  } catch (error) {
    logger.error('Failed to fetch audit logs:', error);
    res.status(500).json({ error: 'Failed to fetch audit logs', details: error });
  }
  }
);

export default router;
