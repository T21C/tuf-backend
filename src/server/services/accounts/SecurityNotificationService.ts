import type { Request } from 'express';
import User from '@/models/auth/User.js';
import { emailService, formatEmailDate } from '@/misc/utils/auth/email.js';
import { parseClientIp } from '@/misc/utils/auth/rateLimitSubjects.js';
import { lookupIpLocation } from '@/misc/utils/auth/ipLocation.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { hasFlag } from '@/misc/utils/auth/permissionUtils.js';
import { permissionFlags } from '@/config/constants.js';

export type SecurityEvent =
  | 'new-signin'
  | 'password-changed'
  | 'password-set'
  | 'password-reset'
  | 'deletion-scheduled'
  | 'oauth-unlinked'
  | 'passkey-added'
  | 'passkey-removed';

export interface SecurityEventDetails {
  req?: Request;
  userAgent?: string | null;
  ip?: string | null;
  remembered?: boolean;
  method?: 'password' | 'discord' | 'passkey' | string;
  provider?: string;
  executeAt?: Date;
  name?: string;
}

function userHasVerifiedEmail(user: {
  email?: string | null;
  permissionFlags?: bigint | number | null;
} | null | undefined): boolean {
  if (!user?.email?.trim()) return false;
  return hasFlag(user.permissionFlags ?? 0, permissionFlags.EMAIL_VERIFIED);
}

/**
 * Lightweight UA summary: browser + OS (mirrors client SettingsSessionsPage).
 */
export function summarizeUserAgent(userAgent: string | null | undefined): string {
  if (!userAgent || typeof userAgent !== 'string') return 'Unknown device';
  const ua = userAgent;

  let browser = 'Browser';
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/OPR\/|Opera/i.test(ua)) browser = 'Opera';
  else if (/Chrome\//i.test(ua) && !/Chromium/i.test(ua)) browser = 'Chrome';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Safari\//i.test(ua) && !/Chrome/i.test(ua)) browser = 'Safari';

  let os = '';
  if (/Windows NT/i.test(ua)) os = 'Windows';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/iPhone|iPad|iPod/i.test(ua)) os = 'iOS';
  else if (/Mac OS X/i.test(ua)) os = 'macOS';
  else if (/Linux/i.test(ua)) os = 'Linux';

  if (browser !== 'Browser' || os) {
    return os ? `${browser} on ${os}` : browser;
  }
  return ua.length > 64 ? `${ua.slice(0, 61)}…` : ua;
}

function resolveContext(details: SecurityEventDetails = {}) {
  const ip =
    details.ip ??
    (details.req ? parseClientIp(details.req) : null) ??
    null;
  const userAgent =
    details.userAgent ??
    details.req?.get('user-agent') ??
    null;
  const location = lookupIpLocation(ip)?.label || 'Unknown location';
  const device = summarizeUserAgent(userAgent);
  return { ip, userAgent, location, device };
}

class SecurityNotificationService {
  /**
   * Fire-and-forget security email. Failures are logged and never thrown.
   * Accounts without a verified email are skipped.
   */
  notify(userId: string, event: SecurityEvent, details: SecurityEventDetails = {}): void {
    void this.dispatch(userId, event, details).catch((err) => {
      logger.warn('[SecurityNotification] dispatch failed', {
        userId,
        event,
        message: err instanceof Error ? err.message : String(err),
      });
    });
  }

  private async dispatch(
    userId: string,
    event: SecurityEvent,
    details: SecurityEventDetails,
  ): Promise<void> {
    const user = await User.findByPk(userId, {
      attributes: ['id', 'email', 'permissionFlags'],
    });
    if (!user || !userHasVerifiedEmail(user) || !user.email) return;

    const to = user.email;
    let sent = false;

    switch (event) {
      case 'new-signin': {
        const ctx = resolveContext(details);
        sent = await emailService.sendNewSignInAlert({
          to,
          device: ctx.device,
          location: ctx.location,
          when: formatEmailDate(new Date()),
          remembered: Boolean(details.remembered),
          method: details.method,
        });
        break;
      }
      case 'password-changed':
        sent = await emailService.sendPasswordChangedAlert({ to, kind: 'changed' });
        break;
      case 'password-set':
        sent = await emailService.sendPasswordChangedAlert({ to, kind: 'set' });
        break;
      case 'password-reset':
        sent = await emailService.sendPasswordResetAlert({ to });
        break;
      case 'deletion-scheduled':
        if (!details.executeAt) return;
        sent = await emailService.sendDeletionScheduledAlert({
          to,
          executeAt: details.executeAt,
        });
        break;
      case 'oauth-unlinked':
        sent = await emailService.sendOAuthUnlinkedAlert({
          to,
          provider: details.provider || 'provider',
        });
        break;
      case 'passkey-added':
        sent = await emailService.sendPasskeyAddedAlert({
          to,
          name: details.name || 'Passkey',
        });
        break;
      case 'passkey-removed':
        sent = await emailService.sendPasskeyRemovedAlert({
          to,
          name: details.name || 'Passkey',
        });
        break;
      default:
        return;
    }

    if (!sent) {
      logger.warn('[SecurityNotification] email send returned false', { userId, event });
    }
  }
}

export const securityNotificationService = new SecurityNotificationService();
