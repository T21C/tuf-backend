import {Request, Response} from 'express';
import {RateLimiter} from '@/server/decorators/rateLimiter.js';
import {totpService, TotpError} from '@/server/services/auth/TotpService.js';
import {sessionIssuanceService} from '@/server/services/auth/SessionIssuanceService.js';
import {trustedDeviceService} from '@/server/services/auth/TrustedDeviceService.js';
import {securityNotificationService} from '@/server/services/accounts/SecurityNotificationService.js';
import {logger} from '@/server/services/core/LoggerService.js';
import User from '@/models/auth/User.js';

function mapTotpError(error: unknown, res: Response, fallback: string): Response {
  if (error instanceof TotpError) {
    return res.status(error.statusCode).json({
      message: error.message,
      code: error.code,
    });
  }
  logger.error(fallback, error);
  return res.status(500).json({message: fallback});
}

function readCode(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const code = (body as {code?: unknown}).code;
  return typeof code === 'string' ? code : undefined;
}

async function finishMfaLogin(
  req: Request,
  res: Response,
  user: User,
  rememberDevice: boolean,
): Promise<Response> {
  if (rememberDevice) {
    await trustedDeviceService.trust(user.id, req, res);
  }

  const auth = await sessionIssuanceService.completeAuthentication(user, req, res, {
    mfaExempt: true,
  });
  if (auth.status !== 'session') {
    return res.status(500).json({message: 'Login failed'});
  }

  await user.update({lastLogin: new Date()});

  securityNotificationService.notify(user.id, 'new-signin', {
    req,
    remembered: rememberDevice,
    method: 'password',
  });

  return res.json({
    status: 'session',
    user: auth.user,
    expiresIn: auth.expiresIn,
    sessionId: auth.sessionId,
  });
}

class TotpController {
  @RateLimiter({
    windowMs: 15 * 60 * 1000,
    maxAttempts: 10,
    blockDuration: 15 * 60 * 1000,
    type: 'totp-setup',
    incrementOnSuccess: true,
  })
  public async setup(req: Request, res: Response): Promise<Response> {
    try {
      if (!req.user?.id) {
        return res.status(401).json({message: 'Not authenticated'});
      }
      const result = await totpService.setup(req.user.id, readCode(req.body));
      return res.json(result);
    } catch (error) {
      return mapTotpError(error, res, 'Failed to start authenticator setup');
    }
  }

  @RateLimiter({
    windowMs: 15 * 60 * 1000,
    maxAttempts: 12,
    blockDuration: 15 * 60 * 1000,
    type: 'totp-confirm',
    incrementOnFailure: true,
  })
  public async confirm(req: Request, res: Response): Promise<Response> {
    try {
      if (!req.user?.id) {
        return res.status(401).json({message: 'Not authenticated'});
      }
      const result = await totpService.confirm(req.user.id, readCode(req.body));
      return res.json(result);
    } catch (error) {
      return mapTotpError(error, res, 'Failed to confirm authenticator');
    }
  }

  @RateLimiter({
    windowMs: 15 * 60 * 1000,
    maxAttempts: 12,
    blockDuration: 15 * 60 * 1000,
    type: 'totp-recovery-regenerate',
    incrementOnFailure: true,
  })
  public async regenerateRecovery(req: Request, res: Response): Promise<Response> {
    try {
      if (!req.user?.id) {
        return res.status(401).json({message: 'Not authenticated'});
      }
      const result = await totpService.regenerateRecovery(req.user.id, readCode(req.body));
      return res.json(result);
    } catch (error) {
      return mapTotpError(error, res, 'Failed to regenerate recovery codes');
    }
  }

  @RateLimiter({
    windowMs: 15 * 60 * 1000,
    maxAttempts: 12,
    blockDuration: 15 * 60 * 1000,
    type: 'totp-disable',
    incrementOnFailure: true,
  })
  public async disable(req: Request, res: Response): Promise<Response> {
    try {
      if (!req.user?.id) {
        return res.status(401).json({message: 'Not authenticated'});
      }
      await totpService.disable(req.user.id, readCode(req.body));
      return res.json({message: 'Authenticator disabled'});
    } catch (error) {
      return mapTotpError(error, res, 'Failed to disable authenticator');
    }
  }

  @RateLimiter({
    windowMs: 15 * 60 * 1000,
    maxAttempts: 12,
    blockDuration: 15 * 60 * 1000,
    type: 'mfa-totp-verify',
    incrementOnFailure: true,
  })
  public async verifyLoginTotp(req: Request, res: Response): Promise<Response> {
    try {
      const pending = sessionIssuanceService.readMfaPending(req);
      if (!pending) {
        return res.status(401).json({
          message: 'Login challenge expired. Please sign in again.',
          code: 'MFA_PENDING_REQUIRED',
        });
      }
      if (!pending.methods.includes('totp')) {
        return res.status(400).json({
          message: 'Authenticator MFA is not available for this login',
          code: 'MFA_METHOD_UNAVAILABLE',
        });
      }
      const rememberDevice = req.body?.rememberDevice === true;
      const user = await totpService.verifyLoginTotp(pending.sub, readCode(req.body));
      return finishMfaLogin(req, res, user, rememberDevice);
    } catch (error) {
      return mapTotpError(error, res, 'Authenticator verification failed');
    }
  }

  @RateLimiter({
    windowMs: 15 * 60 * 1000,
    maxAttempts: 12,
    blockDuration: 15 * 60 * 1000,
    type: 'mfa-recovery-verify',
    incrementOnFailure: true,
  })
  public async verifyLoginRecovery(req: Request, res: Response): Promise<Response> {
    try {
      const pending = sessionIssuanceService.readMfaPending(req);
      if (!pending) {
        return res.status(401).json({
          message: 'Login challenge expired. Please sign in again.',
          code: 'MFA_PENDING_REQUIRED',
        });
      }
      if (!pending.methods.includes('totp')) {
        return res.status(400).json({
          message: 'Recovery codes are not available for this login',
          code: 'MFA_METHOD_UNAVAILABLE',
        });
      }
      const rememberDevice = req.body?.rememberDevice === true;
      const user = await totpService.verifyLoginRecovery(pending.sub, readCode(req.body));
      return finishMfaLogin(req, res, user, rememberDevice);
    } catch (error) {
      return mapTotpError(error, res, 'Recovery code verification failed');
    }
  }
}

export const totpController = new TotpController();
