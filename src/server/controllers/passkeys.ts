import { Request, Response } from 'express';
import { RateLimiter } from '@/server/decorators/rateLimiter.js';
import {
  passkeyService,
  PasskeyError,
} from '@/server/services/auth/PasskeyService.js';
import { sessionIssuanceService } from '@/server/services/auth/SessionIssuanceService.js';
import { securityNotificationService } from '@/server/services/accounts/SecurityNotificationService.js';
import { logger } from '@/server/services/core/LoggerService.js';
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from '@simplewebauthn/server';

function mapPasskeyError(error: unknown, res: Response, fallback: string): Response {
  if (error instanceof PasskeyError) {
    return res.status(error.statusCode).json({
      message: error.message,
      code: error.code,
    });
  }
  logger.error(fallback, error);
  return res.status(500).json({ message: fallback });
}

class PasskeyController {
  public async registerOptions(req: Request, res: Response): Promise<Response> {
    try {
      if (!req.user) {
        return res.status(401).json({ message: 'Not authenticated' });
      }
      const options = await passkeyService.registrationOptions(req.user as never);
      return res.json(options);
    } catch (error) {
      return mapPasskeyError(error, res, 'Failed to start passkey registration');
    }
  }

  public async registerVerify(req: Request, res: Response): Promise<Response> {
    try {
      if (!req.user) {
        return res.status(401).json({ message: 'Not authenticated' });
      }
      const { response, name } = req.body || {};
      if (!response || typeof response !== 'object') {
        return res.status(400).json({
          message: 'Registration response is required',
          code: 'PASSKEY_INVALID',
        });
      }
      const passkey = await passkeyService.verifyRegistration(
        req.user as never,
        response as RegistrationResponseJSON,
        typeof name === 'string' ? name : null,
        req.get('user-agent'),
      );
      securityNotificationService.notify(req.user.id, 'passkey-added', {
        req,
        name: passkey.name,
      });
      return res.status(201).json({ passkey });
    } catch (error) {
      return mapPasskeyError(error, res, 'Failed to register passkey');
    }
  }

  public async list(req: Request, res: Response): Promise<Response> {
    try {
      if (!req.user?.id) {
        return res.status(401).json({ message: 'Not authenticated' });
      }
      const passkeys = await passkeyService.listForUser(req.user.id);
      return res.json({ passkeys });
    } catch (error) {
      return mapPasskeyError(error, res, 'Failed to list passkeys');
    }
  }

  public async rename(req: Request, res: Response): Promise<Response> {
    try {
      if (!req.user?.id) {
        return res.status(401).json({ message: 'Not authenticated' });
      }
      const { id } = req.params;
      const { name } = req.body || {};
      if (!id) {
        return res.status(400).json({ message: 'Passkey id required' });
      }
      if (!name || typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ message: 'Name is required', code: 'NAME_REQUIRED' });
      }
      const passkey = await passkeyService.rename(req.user.id, id, name);
      return res.json({ passkey });
    } catch (error) {
      return mapPasskeyError(error, res, 'Failed to rename passkey');
    }
  }

  public async remove(req: Request, res: Response): Promise<Response> {
    try {
      if (!req.user?.id) {
        return res.status(401).json({ message: 'Not authenticated' });
      }
      const { id } = req.params;
      if (!id) {
        return res.status(400).json({ message: 'Passkey id required' });
      }
      const { name } = await passkeyService.remove(req.user.id, id);
      securityNotificationService.notify(req.user.id, 'passkey-removed', {
        req,
        name,
      });
      return res.status(204).send();
    } catch (error) {
      return mapPasskeyError(error, res, 'Failed to remove passkey');
    }
  }

  @RateLimiter({
    windowMs: 15 * 60 * 1000,
    maxAttempts: 30,
    blockDuration: 15 * 60 * 1000,
    type: 'passkey-login-options',
  })
  public async loginOptions(req: Request, res: Response): Promise<Response> {
    try {
      const options = await passkeyService.authenticationOptions();
      return res.json(options);
    } catch (error) {
      return mapPasskeyError(error, res, 'Failed to start passkey login');
    }
  }

  @RateLimiter({
    windowMs: 15 * 60 * 1000,
    maxAttempts: 12,
    blockDuration: 15 * 60 * 1000,
    type: 'passkey-login-verify',
    incrementOnFailure: true,
  })
  public async loginVerify(req: Request, res: Response): Promise<Response> {
    try {
      const { response } = req.body || {};
      if (!response || typeof response !== 'object') {
        return res.status(400).json({
          message: 'Authentication response is required',
          code: 'PASSKEY_INVALID',
        });
      }

      const { user } = await passkeyService.verifyAuthentication(
        response as AuthenticationResponseJSON,
        { requireUserVerification: true },
      );

      if (user.status !== 'active') {
        return res.status(403).json({
          message: 'Account is not active',
          code: 'ACCOUNT_INACTIVE',
        });
      }

      const auth = await sessionIssuanceService.completeAuthentication(user, req, res, {
        mfaExempt: true,
      });
      if (auth.status !== 'session') {
        return res.status(500).json({ message: 'Login failed' });
      }

      await user.update({ lastLogin: new Date() });

      securityNotificationService.notify(user.id, 'new-signin', {
        req,
        method: 'passkey',
      });

      return res.json({
        status: 'session',
        user: auth.user,
        expiresIn: auth.expiresIn,
        sessionId: auth.sessionId,
      });
    } catch (error) {
      return mapPasskeyError(error, res, 'Passkey login failed');
    }
  }
}

export const passkeyController = new PasskeyController();
