import crypto from 'crypto';
import type { Request, Response } from 'express';
import { Op } from 'sequelize';
import TrustedDevice from '@/models/auth/TrustedDevice.js';
import { AUTH_COOKIE_OPTIONS, cookieClearOptions } from '@/misc/utils/auth/auth.js';
import { parseClientIp } from '@/misc/utils/auth/rateLimitSubjects.js';
import { lookupIpLocation, type IpLocationInfo } from '@/misc/utils/auth/ipLocation.js';
import { TRUSTED_DEVICE_TTL_SEC } from '@/config/auth.config.js';

const TRUSTED_DEVICE_COOKIE = 'trustedDevice';
const TRUSTED_DEVICE_COOKIE_PATH = '/v2/auth';

/** Oldest devices beyond this cap are revoked on each new trust (bounds DB growth and stale skips). */
const MAX_TRUSTED_DEVICES_PER_USER = 10;

const TRUSTED_DEVICE_COOKIE_OPTIONS = {
  ...AUTH_COOKIE_OPTIONS,
  path: TRUSTED_DEVICE_COOKIE_PATH,
  maxAge: TRUSTED_DEVICE_TTL_SEC * 1000,
};

function hashDeviceToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export interface TrustedDeviceInfo {
  id: string;
  userAgent: string | null;
  ip: string | null;
  location: IpLocationInfo | null;
  lastUsedAt: Date;
  expiresAt: Date;
  createdAt: Date;
  isCurrent: boolean;
}

class TrustedDeviceService {
  cookieName = TRUSTED_DEVICE_COOKIE;

  /**
   * Issue a trusted-device cookie + DB row so login MFA is skipped for TTL days.
   */
  async trust(userId: string, req: Request, res: Response): Promise<string> {
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashDeviceToken(token);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + TRUSTED_DEVICE_TTL_SEC * 1000);
    const ip = parseClientIp(req);

    await TrustedDevice.create({
      userId,
      tokenHash,
      userAgent: req.get('user-agent') ?? null,
      ip,
      lastUsedAt: now,
      expiresAt,
      revokedAt: null,
      createdAt: now,
      updatedAt: now,
    });

    // Cap active devices per user; drop the least recently used first.
    const active = await TrustedDevice.findAll({
      where: {
        userId,
        revokedAt: null,
        expiresAt: { [Op.gt]: now },
      },
      order: [['lastUsedAt', 'DESC']],
      attributes: ['id'],
    });
    if (active.length > MAX_TRUSTED_DEVICES_PER_USER) {
      const surplusIds = active.slice(MAX_TRUSTED_DEVICES_PER_USER).map((r) => r.id);
      await TrustedDevice.update(
        { revokedAt: now },
        { where: { id: surplusIds } },
      );
    }

    res.cookie(TRUSTED_DEVICE_COOKIE, token, TRUSTED_DEVICE_COOKIE_OPTIONS);
    return token;
  }

  /**
   * Whether the request carries a valid, unexpired, non-revoked trusted-device cookie
   * for this user. Bumps lastUsedAt on hit.
   */
  async isTrusted(userId: string, req: Request): Promise<boolean> {
    const raw = req.cookies?.[TRUSTED_DEVICE_COOKIE];
    if (!raw || typeof raw !== 'string') return false;

    const tokenHash = hashDeviceToken(raw);
    const record = await TrustedDevice.findOne({
      where: {
        userId,
        tokenHash,
        revokedAt: null,
        expiresAt: { [Op.gt]: new Date() },
      },
    });
    if (!record) return false;

    await record.update({ lastUsedAt: new Date() });
    return true;
  }

  /** Current cookie's device id for this user, or null. */
  async currentDeviceId(userId: string, req: Request): Promise<string | null> {
    const raw = req.cookies?.[TRUSTED_DEVICE_COOKIE];
    if (!raw || typeof raw !== 'string') return null;
    const tokenHash = hashDeviceToken(raw);
    const record = await TrustedDevice.findOne({
      where: {
        userId,
        tokenHash,
        revokedAt: null,
        expiresAt: { [Op.gt]: new Date() },
      },
      attributes: ['id'],
    });
    return record?.id ?? null;
  }

  async listForUser(userId: string, currentId?: string | null): Promise<TrustedDeviceInfo[]> {
    const records = await TrustedDevice.findAll({
      where: {
        userId,
        revokedAt: null,
        expiresAt: { [Op.gt]: new Date() },
      },
      attributes: ['id', 'userAgent', 'ip', 'lastUsedAt', 'expiresAt', 'createdAt'],
      order: [['lastUsedAt', 'DESC']],
    });
    return records.map((r) => ({
      id: r.id,
      userAgent: r.userAgent ?? null,
      ip: r.ip ?? null,
      location: lookupIpLocation(r.ip),
      lastUsedAt: r.lastUsedAt,
      expiresAt: r.expiresAt,
      createdAt: r.createdAt,
      isCurrent: Boolean(currentId && r.id === currentId),
    }));
  }

  async revoke(deviceId: string, userId: string): Promise<boolean> {
    const [affected] = await TrustedDevice.update(
      { revokedAt: new Date() },
      { where: { id: deviceId, userId, revokedAt: null } },
    );
    return affected > 0;
  }

  async revokeAllForUser(userId: string): Promise<number> {
    const [affected] = await TrustedDevice.update(
      { revokedAt: new Date() },
      { where: { userId, revokedAt: null } },
    );
    return affected;
  }

  clearCookie(res: Response): void {
    res.clearCookie(TRUSTED_DEVICE_COOKIE, cookieClearOptions(TRUSTED_DEVICE_COOKIE_OPTIONS));
  }
}

export const trustedDeviceService = new TrustedDeviceService();

/** Exported for unit tests. */
export { hashDeviceToken };
