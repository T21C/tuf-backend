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

/**
 * One browser cookie holds every account that trusted this browser.
 * Tokens are dot-separated; a single legacy token (no separator) still parses.
 */
const MAX_TRUSTED_DEVICE_TOKENS = 20;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/i;

const TRUSTED_DEVICE_COOKIE_OPTIONS = {
  ...AUTH_COOKIE_OPTIONS,
  path: TRUSTED_DEVICE_COOKIE_PATH,
  maxAge: TRUSTED_DEVICE_TTL_SEC * 1000,
};

function hashDeviceToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function parseTrustedDeviceCookie(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  const tokens: string[] = [];
  for (const part of raw.split('.')) {
    if (!TOKEN_PATTERN.test(part) || tokens.includes(part)) continue;
    tokens.push(part);
    if (tokens.length >= MAX_TRUSTED_DEVICE_TOKENS) break;
  }
  return tokens;
}

function tokenForHash(tokens: string[], tokenHash: string): string | null {
  return tokens.find((token) => hashDeviceToken(token) === tokenHash) ?? null;
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
   * Remember this browser for one account without dropping trusts already
   * stored for other accounts on the same device.
   */
  async trust(userId: string, req: Request, res: Response): Promise<string> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + TRUSTED_DEVICE_TTL_SEC * 1000);
    const ip = parseClientIp(req);
    const userAgent = req.get('user-agent') ?? null;
    const prior = await this.retainActiveTokens(this.readTokens(req), now);
    const existingRow = await this.findActiveRow(userId, prior, now);
    const reusedToken = existingRow ? tokenForHash(prior, existingRow.tokenHash) : null;

    let token: string;
    if (existingRow && reusedToken) {
      token = reusedToken;
      await existingRow.update({
        userAgent,
        ip,
        lastUsedAt: now,
        expiresAt,
      });
    } else {
      token = crypto.randomBytes(32).toString('hex');
      await TrustedDevice.create({
        userId,
        tokenHash: hashDeviceToken(token),
        userAgent,
        ip,
        lastUsedAt: now,
        expiresAt,
        revokedAt: null,
        createdAt: now,
        updatedAt: now,
      });
      await this.enforceCap(userId, now);
    }

    const kept = reusedToken
      ? prior
      : await this.retainActiveTokens(prior, now);
    const tokens = kept.filter((candidate) => candidate !== token);
    tokens.push(token);
    this.writeTokens(res, tokens);
    return token;
  }

  /**
   * Whether the request carries a valid, unexpired, non-revoked trusted-device
   * token for this user. Other accounts' tokens in the same cookie are ignored.
   * Bumps lastUsedAt on hit.
   */
  async isTrusted(userId: string, req: Request): Promise<boolean> {
    const record = await this.findActiveRow(userId, this.readTokens(req), new Date());
    if (!record) return false;

    await record.update({ lastUsedAt: new Date() });
    return true;
  }

  /** Current cookie's device id for this user, or null. */
  async currentDeviceId(userId: string, req: Request): Promise<string | null> {
    const record = await this.findActiveRow(userId, this.readTokens(req), new Date());
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

  /** Revoke one device. Returns its token hash so the caller can drop just that token. */
  async revoke(deviceId: string, userId: string): Promise<string | null> {
    const record = await TrustedDevice.findOne({
      where: { id: deviceId, userId, revokedAt: null },
      attributes: ['id', 'tokenHash'],
    });
    if (!record) return null;

    const [affected] = await TrustedDevice.update(
      { revokedAt: new Date() },
      { where: { id: deviceId, userId, revokedAt: null } },
    );
    if (!affected) return null;
    return record.tokenHash;
  }

  /**
   * Remove one account's token from the shared cookie. Tokens for other
   * accounts on this browser stay in place.
   */
  dropRememberedToken(req: Request, res: Response, tokenHash: string): void {
    const tokens = this.readTokens(req);
    const remaining = tokens.filter((token) => hashDeviceToken(token) !== tokenHash);
    if (remaining.length === tokens.length) return;
    this.writeTokens(res, remaining);
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

  private readTokens(req: Request): string[] {
    return parseTrustedDeviceCookie(req.cookies?.[TRUSTED_DEVICE_COOKIE]);
  }

  private writeTokens(res: Response, tokens: string[]): void {
    const bounded = tokens.slice(-MAX_TRUSTED_DEVICE_TOKENS);
    if (!bounded.length) {
      this.clearCookie(res);
      return;
    }
    res.cookie(TRUSTED_DEVICE_COOKIE, bounded.join('.'), TRUSTED_DEVICE_COOKIE_OPTIONS);
  }

  private async findActiveRow(userId: string, tokens: string[], now: Date) {
    if (!tokens.length) return null;
    return TrustedDevice.findOne({
      where: {
        userId,
        tokenHash: { [Op.in]: tokens.map(hashDeviceToken) },
        revokedAt: null,
        expiresAt: { [Op.gt]: now },
      },
      order: [['lastUsedAt', 'DESC']],
    });
  }

  /** Drop cookie tokens that no longer match an active row for any account. */
  private async retainActiveTokens(tokens: string[], now: Date): Promise<string[]> {
    if (!tokens.length) return [];
    const rows = await TrustedDevice.findAll({
      where: {
        tokenHash: { [Op.in]: tokens.map(hashDeviceToken) },
        revokedAt: null,
        expiresAt: { [Op.gt]: now },
      },
      attributes: ['tokenHash'],
    });
    const live = new Set(rows.map((row) => row.tokenHash));
    return tokens.filter((token) => live.has(hashDeviceToken(token)));
  }

  private async enforceCap(userId: string, now: Date): Promise<void> {
    const active = await TrustedDevice.findAll({
      where: {
        userId,
        revokedAt: null,
        expiresAt: { [Op.gt]: now },
      },
      order: [['lastUsedAt', 'DESC']],
      attributes: ['id'],
    });
    if (active.length <= MAX_TRUSTED_DEVICES_PER_USER) return;
    const surplusIds = active.slice(MAX_TRUSTED_DEVICES_PER_USER).map((row) => row.id);
    await TrustedDevice.update(
      { revokedAt: now },
      { where: { id: surplusIds } },
    );
  }
}

export const trustedDeviceService = new TrustedDeviceService();

/** Exported for unit tests. */
export { hashDeviceToken, parseTrustedDeviceCookie };
