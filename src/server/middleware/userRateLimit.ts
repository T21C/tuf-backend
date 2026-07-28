import type { NextFunction, Request, Response } from 'express';
import { Op } from 'sequelize';

import RateLimit, { type RateLimitCreationAttributes } from '@/models/auth/RateLimit.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { permissionFlags } from '@/config/constants.js';
import { hasAnyFlag } from '@/misc/utils/auth/permissionUtils.js';

export interface UserRateLimiterConfig {
  type: string;
  windowMs: number;
  maxAttempts: number;
  blockDuration: number;
  /** Write/sensitive routes default to fail-closed when storage is unavailable. */
  failClosed?: boolean;
}

/**
 * Trusted roles (rater/curator and above) are exempt from per-user rate limits;
 * only the general public is throttled.
 */
const RATE_LIMIT_EXEMPT_FLAGS = [
  permissionFlags.RATER,
  permissionFlags.CURATOR,
  permissionFlags.HEAD_CURATOR,
  permissionFlags.SUPER_ADMIN,
];

function userRateLimitKey(userId: string): string {
  return `user:${userId}`;
}

/**
 * Per-user rate limiter backed by the existing `rate_limits` table (`ip` stores `user:<id>`).
 */
export function createUserRateLimiter(config: UserRateLimiterConfig) {
  const { type, windowMs, maxAttempts, blockDuration, failClosed = true } = config;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    // Reputation-based exemption: trusted roles bypass the limiter entirely.
    if (hasAnyFlag(req.user, RATE_LIMIT_EXEMPT_FLAGS)) {
      next();
      return;
    }

    const key = userRateLimitKey(userId);

    try {
      const now = new Date();

      const blockedRecord = await RateLimit.findOne({
        where: {
          ip: key,
          type,
          blocked: true,
          blockedUntil: { [Op.gt]: now },
        },
      });

      if (blockedRecord) {
        const retryAfter = Math.max(0, blockedRecord.blockedUntil!.getTime() - now.getTime());
        res.status(429).json({
          error: 'Too many attempts. Please try again later.',
          retryAfter,
        });
        return;
      }

      const windowEnd = new Date(now.getTime() + windowMs);
      let rateLimit = await RateLimit.findOne({
        where: {
          ip: key,
          type,
          windowEnd: { [Op.gt]: now },
        },
        order: [['windowEnd', 'DESC']],
      });

      if (!rateLimit) {
        rateLimit = await RateLimit.create({
          ip: key,
          type,
          attempts: 1,
          windowStart: now,
          windowEnd,
        } as RateLimitCreationAttributes);
      } else {
        await rateLimit.increment('attempts');
        await rateLimit.reload();
      }

      if (rateLimit.attempts > maxAttempts) {
        const blockedUntil = new Date(now.getTime() + blockDuration);
        await rateLimit.update({ blocked: true, blockedUntil });
        res.status(429).json({
          error: 'Too many attempts. Please try again later.',
          retryAfter: blockDuration,
        });
        return;
      }

      next();
    } catch (error) {
      logger.error('User rate limiter error:', error);
      if (failClosed) {
        res.status(503).json({
          error: 'Request protection is temporarily unavailable. Please try again later.',
          code: 'RATE_LIMIT_UNAVAILABLE',
        });
        return;
      }
      next();
    }
  };
}
