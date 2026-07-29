import { NextFunction, Request, Response } from 'express';
import { logger } from '@/server/services/core/LoggerService.js';
import { Op } from 'sequelize';
import RateLimit, { type RateLimitCreationAttributes } from '@/models/auth/RateLimit.js';
import {
  parseClientIp,
  rateLimitSubjectAccount,
  rateLimitSubjectIp,
  rateLimitSubjectUser,
  type RateLimitSubjectKind,
} from '@/misc/utils/auth/rateLimitSubjects.js';

export interface RateLimiterConfig {
  windowMs: number;
  maxAttempts: number;
  blockDuration: number;
  type: string;
  incrementOnFailure?: boolean;
  incrementOnSuccess?: boolean;
  /** Rate-limit by IP and/or authenticated user. Default: ['ip']. */
  subjects?: RateLimitSubjectKind[];
  /** Optional unauthenticated account identifier (email/username) bucket. */
  accountIdentifier?: (req: Request) => unknown;
  /** Block sensitive requests when the backing store is unavailable. */
  failClosed?: boolean;
}

interface RateLimitConfig {
  windowMs: number;
  maxAttempts: number;
  blockDuration: number;
  type: string;
  failClosed: boolean;
}

const defaultConfig: RateLimitConfig = {
  windowMs: 24 * 60 * 60 * 1000,
  maxAttempts: 3,
  blockDuration: 7 * 24 * 60 * 60 * 1000,
  type: 'default',
  failClosed: false,
};

export class RateLimitStorageError extends Error {
  constructor(operation: string, cause: unknown) {
    super(`Rate limit storage unavailable during ${operation}`, { cause });
    this.name = 'RateLimitStorageError';
  }
}

function resolveSubjects(
  req: Request,
  kinds: RateLimitSubjectKind[],
  accountIdentifier?: (req: Request) => unknown,
): string[] {
  const subjects: string[] = [];
  for (const kind of kinds) {
    if (kind === 'ip') {
      subjects.push(rateLimitSubjectIp(parseClientIp(req)));
    } else if (kind === 'user' && req.user?.id) {
      subjects.push(rateLimitSubjectUser(req.user.id));
    }
  }
  const accountSubject = rateLimitSubjectAccount(accountIdentifier?.(req));
  if (accountSubject) {
    subjects.push(accountSubject);
  }
  // Always have at least IP so unauthenticated routes still rate-limit
  if (subjects.length === 0) {
    subjects.push(rateLimitSubjectIp(parseClientIp(req)));
  }
  return [...new Set(subjects)];
}

function rateLimitUnavailable(res: Response): Response {
  return res.status(503).json({
    message: 'Authentication protection is temporarily unavailable. Please try again later.',
    code: 'RATE_LIMIT_UNAVAILABLE',
  });
}

/** Send a 429 with body + headers (headers matter for HEAD, where bodies are omitted). */
export function sendRateLimited(
  res: Response,
  retryAfterMs: number,
  message = 'Too many attempts. Please try again later.',
): Response {
  const ms = Math.max(0, Math.ceil(retryAfterMs));
  res.setHeader('Retry-After', String(Math.ceil(ms / 1000)));
  res.setHeader('X-Retry-After-Ms', String(ms));
  return res.status(429).json({
    message,
    retryAfter: ms,
  });
}

export function RateLimiter(innerConfig: Partial<RateLimiterConfig> = {}) {
  const {
    windowMs = 24 * 60 * 60 * 1000,
    maxAttempts = 3,
    blockDuration = 7 * 24 * 60 * 60 * 1000,
    type = 'default',
    incrementOnFailure = true,
    incrementOnSuccess = false,
    subjects: subjectKinds = ['ip'],
    accountIdentifier,
    failClosed = false,
  } = { ...defaultConfig, ...innerConfig };

  const config: RateLimiterConfig = {
    windowMs,
    maxAttempts,
    blockDuration,
    type,
    incrementOnFailure,
    incrementOnSuccess,
    subjects: subjectKinds,
    accountIdentifier,
    failClosed,
  };

  return function (
    _target: unknown,
    _propertyKey: string,
    descriptor: PropertyDescriptor,
  ) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (req: Request, res: Response) {
      const subjects = resolveSubjects(
        req,
        config.subjects || ['ip'],
        config.accountIdentifier,
      );

      try {
        for (const subject of subjects) {
          const { blocked, retryAfter } = await isBlocked(subject, config);
          if (blocked) {
            logger.debug(
              `Request blocked for ${subject} due to ${config.type} rate limiting. Retry after: ${retryAfter}ms`,
            );
            return sendRateLimited(res, retryAfter);
          }
        }

        const result = await originalMethod.apply(this, [req, res]);
        const isSuccess = res.statusCode >= 200 && res.statusCode < 300;

        if (isSuccess && incrementOnSuccess) {
          for (const subject of subjects) {
            await increment(subject, config);
          }
        } else if (!isSuccess && incrementOnFailure) {
          for (const subject of subjects) {
            await increment(subject, config);
          }
        }

        return result;
      } catch (error) {
        if (error instanceof RateLimitStorageError) {
          logger.error(`${config.type} rate limit storage failure:`, error);
          if (config.failClosed && !res.headersSent) {
            return rateLimitUnavailable(res);
          }
          if (res.headersSent) return res;
        }
        if (incrementOnFailure) {
          try {
            for (const subject of subjects) {
              await increment(subject, config);
            }
          } catch (incrementError) {
            logger.error(`Failed to increment ${config.type} rate limit:`, incrementError);
          }
        }
        throw error;
      }
    };

    return descriptor;
  };
}

async function isBlocked(subject: string, config: RateLimiterConfig) {
  try {
    const blockedRecord = await RateLimit.findOne({
      where: {
        ip: subject,
        type: config.type,
        blocked: true,
        blockedUntil: {
          [Op.gt]: new Date(),
        },
      },
    });

    if (blockedRecord) {
      return {
        blocked: true,
        retryAfter: Math.ceil(blockedRecord.blockedUntil!.getTime() - Date.now()),
      };
    }

    return { blocked: false, retryAfter: 0 };
  } catch (error) {
    logger.error('Rate limiter isBlocked error:', error);
    if (config.failClosed) {
      throw new RateLimitStorageError('block check', error);
    }
    return { blocked: false, retryAfter: 0 };
  }
}

async function cleanupExpiredRateLimits(subject: string, type: string) {
  try {
    const now = new Date();
    await RateLimit.destroy({
      where: {
        ip: subject,
        type,
        windowEnd: {
          [Op.lte]: now,
        },
        blocked: false,
      },
    });
  } catch (error) {
    logger.error('Error cleaning up expired rate limits:', error);
  }
}

async function increment(subject: string, config: RateLimiterConfig) {
  try {
    const now = new Date();
    const windowEnd = new Date(now.getTime() + config.windowMs);

    let rateLimit = await RateLimit.findOne({
      where: {
        ip: subject,
        type: config.type,
        windowEnd: {
          [Op.gt]: now,
        },
      },
      order: [['windowEnd', 'DESC']],
    });

    if (!rateLimit) {
      await cleanupExpiredRateLimits(subject, config.type);
      rateLimit = await RateLimit.create({
        ip: subject,
        type: config.type,
        attempts: 1,
        windowStart: now,
        windowEnd,
      } as RateLimitCreationAttributes);
    } else {
      await rateLimit.increment('attempts');
      await rateLimit.reload();
    }

    if (rateLimit.attempts > config.maxAttempts) {
      const blockedUntil = new Date(now.getTime() + config.blockDuration);
      await rateLimit.update({
        blocked: true,
        blockedUntil,
      });
      logger.debug(`Subject ${subject} blocked for exceeding ${config.type} limit`);
      return true;
    }

    return false;
  } catch (error) {
    logger.error('Rate limiter increment error:', error);
    if (config.failClosed) {
      throw new RateLimitStorageError('increment', error);
    }
    return false;
  }
}

export const createRateLimiter = (config: Partial<RateLimiterConfig> = {}) => {
  const {
    windowMs = defaultConfig.windowMs,
    maxAttempts = defaultConfig.maxAttempts,
    blockDuration = defaultConfig.blockDuration,
    type = 'default',
    failClosed = false,
  } = { ...defaultConfig, ...config };

  return {
    middleware: async (req: Request, res: Response, next: NextFunction) => {
      const subject = rateLimitSubjectIp(parseClientIp(req));
      try {
        const blockedRecord = await RateLimit.findOne({
          where: {
            ip: subject,
            type,
            blocked: true,
            blockedUntil: { [Op.gt]: new Date() },
          },
        });

        if (blockedRecord) {
          const remainingBlockTime = Math.ceil(
            blockedRecord.blockedUntil!.getTime() - Date.now(),
          );
          return sendRateLimited(res, remainingBlockTime);
        }

        const now = new Date();
        const windowEnd = new Date(now.getTime() + windowMs);
        let rateLimit = await RateLimit.findOne({
          where: {
            ip: subject,
            type,
            windowEnd: { [Op.gt]: now },
          },
          order: [['windowEnd', 'DESC']],
        });

        if (!rateLimit) {
          await cleanupExpiredRateLimits(subject, type);
          rateLimit = await RateLimit.create({
            ip: subject,
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
          return sendRateLimited(
            res,
            blockDuration,
            'Rate limit exceeded. IP address blocked.',
          );
        }

        res.setHeader('X-RateLimit-Limit', maxAttempts);
        res.setHeader(
          'X-RateLimit-Remaining',
          Math.max(0, maxAttempts - rateLimit.attempts),
        );
        return next();
      } catch (error) {
        logger.error('Rate limiter error:', error);
        if (failClosed) {
          return rateLimitUnavailable(res);
        }
        return next();
      }
    },

    increment: async (ip: string) => {
      const subject = ip.startsWith('ip:') || ip.startsWith('user:') ? ip : rateLimitSubjectIp(ip);
      return increment(subject, {
        windowMs,
        maxAttempts,
        blockDuration,
        type,
        failClosed,
      });
    },

    isLimited: async (ip: string) => {
      const subject = ip.startsWith('ip:') || ip.startsWith('user:') ? ip : rateLimitSubjectIp(ip);
      const rateLimit = await RateLimit.findOne({
        where: { ip: subject, type },
        order: [['windowEnd', 'DESC']],
      });
      return Boolean(rateLimit?.attempts && rateLimit.attempts > maxAttempts);
    },

    isBlocked: async (ip: string) => {
      const subject = ip.startsWith('ip:') || ip.startsWith('user:') ? ip : rateLimitSubjectIp(ip);
      return isBlocked(subject, {
        windowMs,
        maxAttempts,
        blockDuration,
        type,
        failClosed,
      });
    },
  };
};

/**
 * Failure-counted rate limit for credential gates (password checks, etc.).
 * Checks block state before the attempt; call `recordFailure` only on bad credentials.
 */
export function createFailureAwareRateLimit(innerConfig: Partial<RateLimiterConfig>) {
  const config: RateLimiterConfig = {
    windowMs: innerConfig.windowMs ?? defaultConfig.windowMs,
    maxAttempts: innerConfig.maxAttempts ?? defaultConfig.maxAttempts,
    blockDuration: innerConfig.blockDuration ?? defaultConfig.blockDuration,
    type: innerConfig.type ?? defaultConfig.type,
    subjects: innerConfig.subjects ?? ['ip'],
    accountIdentifier: innerConfig.accountIdentifier,
    failClosed: innerConfig.failClosed ?? true,
    incrementOnFailure: true,
    incrementOnSuccess: false,
  };

  const subjectsFor = (req: Request) =>
    resolveSubjects(req, config.subjects || ['ip'], config.accountIdentifier);

  return {
    /**
     * If any subject is blocked, send 429 and return true.
     * On storage failure with failClosed, send 503 and return true.
     */
    async rejectIfBlocked(req: Request, res: Response): Promise<boolean> {
      try {
        for (const subject of subjectsFor(req)) {
          const { blocked, retryAfter } = await isBlocked(subject, config);
          if (blocked) {
            sendRateLimited(res, retryAfter);
            return true;
          }
        }
        return false;
      } catch (error) {
        if (error instanceof RateLimitStorageError) {
          logger.error(`${config.type} rate limit storage failure:`, error);
          if (config.failClosed) {
            rateLimitUnavailable(res);
            return true;
          }
        } else {
          logger.error(`${config.type} rate limit check failed:`, error);
          if (config.failClosed) {
            rateLimitUnavailable(res);
            return true;
          }
        }
        return false;
      }
    },

    /** Increment failure counters; returns whether the subject is now blocked. */
    async recordFailure(req: Request): Promise<{ blocked: boolean; retryAfter: number }> {
      let blocked = false;
      let retryAfter = 0;
      try {
        for (const subject of subjectsFor(req)) {
          await increment(subject, config);
          const state = await isBlocked(subject, config);
          if (state.blocked) {
            blocked = true;
            retryAfter = Math.max(retryAfter, state.retryAfter);
          }
        }
      } catch (error) {
        logger.error(`${config.type} rate limit increment failed:`, error);
        if (config.failClosed) {
          throw error instanceof RateLimitStorageError
            ? error
            : new RateLimitStorageError('increment', error);
        }
      }
      return { blocked, retryAfter };
    },
  };
}
