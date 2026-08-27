import {Request, Response, NextFunction} from 'express';
import {User, OAuthProvider, UserTufStellarBilling} from '@/models/index.js';
import {tokenUtils, cookieUtils, ACCESS_COOKIE_MAX_AGE_SEC, REFRESH_COOKIE_MAX_AGE_SEC, refreshTokenService} from '@/misc/utils/auth/auth.js';
import type {UserAttributes} from '@/models/auth/User.js';
import Player from '@/models/players/Player.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { AuditLogService } from '@/server/services/core/AuditLogService.js';
import PlayerStats from '@/models/players/PlayerStats.js';
import Difficulty from '@/models/levels/Difficulty.js';
import { permissionFlags } from '@/config/constants.js';
import { hasAnyFlag, hasFlag } from '@/misc/utils/auth/permissionUtils.js';
import { canUseStellarProfileCustomization } from '@/misc/utils/subscriptions/tufStellarSubscription.js';
import {
  createFailureAwareRateLimit,
  RateLimitStorageError,
  sendRateLimited,
} from '@/server/decorators/rateLimiter.js';
import {verifySuperAdminProof} from '@/misc/utils/auth/superAdminProof.js';

/**
 * Columns loaded onto `req.user`.
 *
 * Deliberately omits every piece of credential material — `password`,
 * `passwordResetToken`, `passwordResetTokenHash`, `emailVerifyTokenHash` — so a
 * handler that serialises `req.user` cannot leak a hash or a reset token. The
 * paired expiry timestamps stay because they are not secrets and
 * `getEmailResendAvailableAt` needs `emailVerifyExpires`.
 *
 * Handlers that genuinely need the password hash (to verify a current password)
 * must load it explicitly for the one user they are checking.
 */
const REQUEST_USER_ATTRIBUTES = [
  'id',
  'username',
  'email',
  'pendingEmail',
  'passwordResetExpires',
  'emailVerifyExpires',
  'isEmailVerified',
  'isRater',
  'isSuperAdmin',
    'isRatingBanned',
    'isTagVoteBanned',
    'status',
  'playerId',
  'creatorId',
  'lastLogin',
  'nickname',
  'avatarId',
  'avatarUrl',
  'permissionFlags',
  'permissionVersion',
  'deletionScheduledAt',
  'deletionExecuteAt',
  'deletionIncludeCreator',
  'deletionSnapshotPermissionFlags',
  'avatarIsGif',
  'lastUsernameChange',
  'previousUsername',
  'createdAt',
  'updatedAt',
] as const;

const getUser = async (id: string): Promise<User | null> => {
  return await User.findByPk(id, {
    attributes: [...REQUEST_USER_ATTRIBUTES],
    include: [
      {
        model: OAuthProvider,
        as: 'providers',
        attributes: ['id', 'userId', 'provider', 'providerId'],
      },
      {
        model: UserTufStellarBilling,
        as: 'tufStellarBilling',
        attributes: ['tufStellarSubscriptionExpiresAt'],
      },
      {
        model: Player,
        as: 'player',
        include: [
          {
            model: PlayerStats,
            as: 'stats',
            include: [
              {
                model: Difficulty,
                as: 'topDiff',
              },
            ],
          },
        ],
      },
    ],
  });
};

// Extend Express Request type to include user
declare global {
  namespace Express {
    interface Request {
      user?: UserAttributes;
      /** Set once baseAuth has verified the token and loaded req.user. */
      authResolved?: boolean;
    }
  }
}

type MiddlewareFunction = (
  req: Request,
  res: Response,
  next: NextFunction,
) => Promise<void>;

/**
 * Get access token from request: cookie first, then Authorization header
 */
function getAccessToken(req: Request): string | null {
  const fromCookie = req.cookies?.accessToken;
  if (fromCookie) return fromCookie;
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) return authHeader.split(' ')[1];
  return null;
}

/**
 * Base authentication middleware - handles access token verification and user lookup
 * Reads token from cookie (accessToken) or Authorization: Bearer
 */
const baseAuth: MiddlewareFunction = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    // The admin gate authenticates before per-route guards run; re-verifying
    // would repeat the token check and the getUser join for the same request.
    // Only baseAuth sets this flag, so the lighter tryUser/addUserToRequest
    // paths can never satisfy a route that asked for full authentication.
    if (req.authResolved) {
      next();
      return;
    }

    const token = getAccessToken(req);
    if (!token) {
      res.status(401).json({error: 'No token provided'});
      return;
    }

    const decoded = tokenUtils.verifyAccessToken(token);
    if (!decoded) {
      res.status(401).json({error: 'Invalid token'});
      return;
    }

    const sessionId = typeof decoded.sid === 'string' ? decoded.sid : null;
    if (!sessionId || !(await refreshTokenService.isSessionActive(sessionId, decoded.id))) {
      // Do not clear cookies here — legacy access JWTs without sid can still refresh.
      // Truly revoked sessions fail refresh next and the client logs out.
      res.status(401).json({error: 'Session revoked', code: 'SESSION_REVOKED'});
      return;
    }

    const fullUser = await getUser(decoded.id);
    if (!fullUser) {
      res.status(401).json({error: 'User not found'});
      return;
    }

    // Check if permissions are up to date; if not, set new access token cookie
    if (fullUser.permissionVersion !== decoded.permissionVersion) {
      const newAccessToken = tokenUtils.generateAccessToken(fullUser, sessionId);
      cookieUtils.setAuthCookies(res, newAccessToken, null, ACCESS_COOKIE_MAX_AGE_SEC, REFRESH_COOKIE_MAX_AGE_SEC);
      res.setHeader('X-Permission-Changed', 'true');
    }

    req.user = fullUser;
    req.authResolved = true;
    next();
  } catch (error) {
    logger.error('Auth middleware error:', error);
    res.status(401).json({error: 'Authentication failed'});
    return;
  }
};

/**
 * Optional auth: attach req.user when a valid token is present; never 401.
 */
const tryUserAuth: MiddlewareFunction = async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
  try {
    const token = getAccessToken(req);
    if (!token) {
      next();
      return;
    }
    const decoded = tokenUtils.verifyAccessToken(token);
    if (!decoded?.id) {
      next();
      return;
    }
    const sessionId = typeof decoded.sid === 'string' ? decoded.sid : null;
    if (!sessionId || !(await refreshTokenService.isSessionActive(sessionId, decoded.id))) {
      next();
      return;
    }
    const fullUser = await getUser(decoded.id);
    if (fullUser) {
      req.user = fullUser;
    }
  } catch (error) {
    logger.debug('Optional auth skipped:', error);
  }
  next();
};

/**
 * Chain middleware functions together
 */
const chainMiddleware = (...middlewares: MiddlewareFunction[]): MiddlewareFunction => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    let index = 0;

    const executeNext = async () => {
      if (index >= middlewares.length) {
        return next();
      }

      const middleware = middlewares[index];
      index++;

      try {
        await middleware(req, res, executeNext);
      } catch (error) {
        logger.error('Middleware chain error:', error);
        res.status(500).json({error: 'Internal server error'});
      }
    };

    await executeNext();
  };
};

/**
 * Permission check middleware factory
 */
const requirePermission = (checkFn: (user: UserAttributes & { tufStellarBilling?: UserTufStellarBilling }) => boolean, errorMessage: string): MiddlewareFunction => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({error: 'User not found'});
      return;
    }

    if (!checkFn(req.user)) {
      res.status(403).json({error: errorMessage});
      return;
    }

    next();
  };
};

/**
 * Audit logging middleware
 */
const auditLogMiddleware: MiddlewareFunction = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  // Only log modification methods
  const MODIFICATION_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];
  if (MODIFICATION_METHODS.includes(req.method)) {
    const oldJson = res.json;
    const oldSend = res.send;
    let responseBody: any;

    res.json = function (body: any) {
      responseBody = body;
      return oldJson.call(this, body);
    };
    res.send = function (body: any) {
      responseBody = JSON.parse(body);
      return oldSend.call(this, body);
    };

    res.on('finish', async () => {
      // Only log successful (2xx/3xx) responses
      if (res.statusCode < 200 || res.statusCode >= 400) return;
      await AuditLogService.log({
        userId: req.user?.id ?? null,
        action: req.route?.path || req.originalUrl,
        route: req.originalUrl,
        method: req.method,
        payload: req.body,
        result: responseBody,
      });
    });
  }

  next();
};

const SUPER_ADMIN_PASSWORD_MAX_ATTEMPTS = 5;
const SUPER_ADMIN_PASSWORD_WINDOW_MS = 15 * 60 * 1000;
const SUPER_ADMIN_PASSWORD_LOCK_MS = 15 * 60 * 1000;

const superAdminPasswordRateLimit = createFailureAwareRateLimit({
  type: 'super-admin-password',
  windowMs: SUPER_ADMIN_PASSWORD_WINDOW_MS,
  maxAttempts: SUPER_ADMIN_PASSWORD_MAX_ATTEMPTS,
  blockDuration: SUPER_ADMIN_PASSWORD_LOCK_MS,
  subjects: ['user', 'ip'],
  failClosed: true,
});

/**
 * Auth middleware factory
 */
export const Auth = {
  /**
   * Require authenticated user
   */
  user: (): MiddlewareFunction => baseAuth,

  /**
   * Attach user if authenticated; continue without 401 if not.
   */
  tryUser: (): MiddlewareFunction => tryUserAuth,

  /**
   * Require authenticated user
   */
  tufStellarUser: (): MiddlewareFunction =>
    chainMiddleware(
      baseAuth,
      requirePermission(
        (user) => canUseStellarProfileCustomization(user, user.tufStellarBilling ?? null),
        'TUF Stellar user access required'
      ),
      auditLogMiddleware
    ),

  /**
   * Require head curator privileges
   */
  headCurator: (): MiddlewareFunction =>
    chainMiddleware(
      baseAuth,
      requirePermission(
        (user) => hasAnyFlag(user, [permissionFlags.HEAD_CURATOR, permissionFlags.SUPER_ADMIN]),
        'Head curator access required'
      ),
      auditLogMiddleware
    ),


  /**
   * Require curator privileges
   */
  curator: (): MiddlewareFunction =>
    chainMiddleware(
      baseAuth,
      requirePermission(
        (user) => hasAnyFlag(user, [
          permissionFlags.CURATOR,
          permissionFlags.SUPER_ADMIN
        ]),
        'Curator access required'
      ),
      auditLogMiddleware
    ),
  /**
   * Require rater privileges
   */
  rater: (): MiddlewareFunction =>
    chainMiddleware(
      baseAuth,
      requirePermission(
        (user) => hasAnyFlag(user, [
          permissionFlags.RATER,
          permissionFlags.SUPER_ADMIN
        ]),
        'Rater access required'
      ),
      auditLogMiddleware
    ),

  /**
   * Require super admin privileges
   */
  superAdmin: (): MiddlewareFunction =>
    chainMiddleware(
      baseAuth,
      requirePermission(
        (user) => hasFlag(user, permissionFlags.SUPER_ADMIN),
        'Super admin access required'
      ),
      auditLogMiddleware
    ),

  /**
   * Require super admin password for sensitive operations
   */
  superAdminPassword: (): MiddlewareFunction => {
    return chainMiddleware(
      Auth.superAdmin(),
      async (req: Request, res: Response, next: NextFunction) => {
        if (await superAdminPasswordRateLimit.rejectIfBlocked(req, res)) {
          return;
        }

        const {origin} = req.query;
        const proofHeader = req.headers['x-super-admin-proof'];
        const provided = typeof proofHeader === 'string' ? proofHeader : '';
        const expected = process.env.SUPER_ADMIN_KEY;
        const requestPath = String(req.originalUrl || req.url || '').split('?')[0];
        const proofOk = Boolean(
          expected &&
            provided &&
            req.user?.id &&
            verifySuperAdminProof({
              proof: provided,
              secret: expected,
              userId: req.user.id,
              username: req.user.username || '',
              method: req.method,
              path: requestPath,
            }),
        );

        if (!proofOk) {
          try {
            const {blocked, retryAfter} =
              await superAdminPasswordRateLimit.recordFailure(req);
            if (blocked) {
              logger.warn(
                `User ${req.user!.id} locked out after incorrect super-admin password attempts while accessing ${origin} at ${req.originalUrl}`,
              );
              sendRateLimited(res, retryAfter);
              return;
            }
          } catch (error) {
            if (error instanceof RateLimitStorageError) {
              logger.error('Super-admin password rate limit storage failure:', error);
              res.status(503).json({
                message: 'Authentication protection is temporarily unavailable. Please try again later.',
                code: 'RATE_LIMIT_UNAVAILABLE',
              });
              return;
            }
            throw error;
          }
          res.status(403).json({message: 'Invalid super admin password'});
          return;
        }

        next();
      }
    );
  },

  /**
   * Require verified email
   */
  verified: (): MiddlewareFunction =>
    chainMiddleware(
      baseAuth,
      requirePermission(
        (user) => hasFlag(user, permissionFlags.EMAIL_VERIFIED),
        'Email verification required'
      )
    ),

  /**
   * Allow specific providers only
   */
  provider: (providerName: string): MiddlewareFunction =>
    chainMiddleware(
      baseAuth,
      requirePermission(
        (user) => {
          // Check if user has the specified provider
          return user.providers?.some(p => p.provider === providerName) || false;
        },
        `This feature requires ${providerName} authentication`
      )
    ),

  /**
   * Optionally attach req.user when a valid, non-revoked session is present.
   * Shares tryUserAuth so REQUEST_USER_ATTRIBUTES and session checks apply.
   */
  addUserToRequest: (): MiddlewareFunction => tryUserAuth,
};
