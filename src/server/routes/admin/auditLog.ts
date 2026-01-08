import { Router, Request, Response } from 'express';
import { Auth } from '../../middleware/auth.js';
import { AuditLog, User } from '../../../models/index.js';
import { Op } from 'sequelize';
import { logger } from '../../../server/services/LoggerService.js';

const router = Router();

// GET /admin/audit-logs
// Query params: userId, action, method, route, startDate, endDate, q (search), page, pageSize, sort, order
router.get('/', Auth.superAdmin(), async (req: Request, res: Response) => {
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
        { action: { [Op.like]: `%${q}%` } },
        { route: { [Op.like]: `%${q}%` } },
      ];
    }

    const offset = (Number(page) - 1) * Number(pageSize);
    const limit = Number(pageSize);

    const { rows, count } = await AuditLog.findAndCountAll({
      where,
      order: [[sort as string, order as string]],
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
});

export default router;
