import crypto from 'crypto';
import { Op, WhereOptions } from 'sequelize';
import {
  OAUTH_CLIENT_NAME_MAX,
  OAUTH_CLIENT_NAME_MIN,
  OAUTH_MAX_CLIENTS_PER_USER,
  OAUTH_MAX_REDIRECT_URIS,
} from '@/config/oauth.config.js';
import {
  parseScopeBitsStored,
  parseScopeString,
  V1_GRANTABLE_MASK,
} from '@/config/oauthScopes.js';
import OAuthClient from '@/models/oauth/OAuthClient.js';
import OAuthGrant from '@/models/oauth/OAuthGrant.js';
import OAuthAuthorizationCode from '@/models/oauth/OAuthAuthorizationCode.js';
import OAuthRefreshToken from '@/models/oauth/OAuthRefreshToken.js';
import User from '@/models/auth/User.js';

export class OAuthClientError extends Error {
  constructor(
    message: string,
    public status: number = 400,
    public code?: string,
  ) {
    super(message);
    this.name = 'OAuthClientError';
  }
}

/** Exact redirect URI match against registration. */
export function isRedirectUriAllowed(registered: string[], candidate: string): boolean {
  return registered.includes(candidate);
}

/**
 * Basic redirect URI shape checks (exact string stored; reject obvious junk).
 */
export function assertValidRedirectUri(uri: string): void {
  const trimmed = uri.trim();
  if (!trimmed || trimmed !== uri) {
    throw new OAuthClientError('redirect_uri must not have leading/trailing whitespace');
  }
  if (trimmed.length > 1024) {
    throw new OAuthClientError('redirect_uri too long');
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new OAuthClientError('redirect_uri is not a valid URI');
  }
  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
  if (scheme === 'javascript' || scheme === 'data' || scheme === 'file' || scheme === 'vbscript') {
    throw new OAuthClientError('redirect_uri scheme is not allowed');
  }
  if (scheme === 'http') {
    const host = parsed.hostname.toLowerCase();
    if (host !== '127.0.0.1' && host !== 'localhost') {
      throw new OAuthClientError('http redirect_uri only allowed for loopback');
    }
  }
}

function generateClientId(): string {
  return crypto.randomBytes(16).toString('hex');
}

function normalizeRedirectUris(uris: unknown): string[] {
  if (!Array.isArray(uris)) {
    throw new OAuthClientError('redirectUris must be an array');
  }
  if (uris.length === 0) {
    throw new OAuthClientError('at least one redirect_uri is required');
  }
  if (uris.length > OAUTH_MAX_REDIRECT_URIS) {
    throw new OAuthClientError(`at most ${OAUTH_MAX_REDIRECT_URIS} redirect URIs allowed`);
  }
  const out: string[] = [];
  for (const u of uris) {
    if (typeof u !== 'string') {
      throw new OAuthClientError('redirect URIs must be strings');
    }
    assertValidRedirectUri(u);
    if (out.includes(u)) continue;
    out.push(u);
  }
  return out;
}

function normalizeAllowedScopes(input: unknown): string {
  if (input == null || input === '') {
    return V1_GRANTABLE_MASK.toString();
  }
  if (typeof input === 'bigint' || typeof input === 'number') {
    const bits = BigInt(input);
    if (bits === 0n) {
      throw new OAuthClientError('allowedScopes must be non-zero');
    }
    if ((bits & ~V1_GRANTABLE_MASK) !== 0n) {
      throw new OAuthClientError('allowedScopes contains non-grantable bits');
    }
    return bits.toString();
  }
  if (typeof input === 'string') {
    const parsed = parseScopeString(input);
    if (!parsed.ok) throw new OAuthClientError(parsed.error);
    if ((parsed.bits & ~V1_GRANTABLE_MASK) !== 0n) {
      throw new OAuthClientError('allowedScopes contains non-grantable bits');
    }
    return parsed.bits.toString();
  }
  if (Array.isArray(input)) {
    // Legacy name list — prefer bigint string going forward.
    const parsed = parseScopeString(input.map(String).join(' '));
    if (!parsed.ok) throw new OAuthClientError(parsed.error);
    return parsed.bits.toString();
  }
  throw new OAuthClientError('allowedScopes must be a permission bitfield (decimal string)');
}

function normalizeName(name: unknown): string {
  if (typeof name !== 'string') throw new OAuthClientError('name is required');
  const trimmed = name.trim();
  if (trimmed.length < OAUTH_CLIENT_NAME_MIN || trimmed.length > OAUTH_CLIENT_NAME_MAX) {
    throw new OAuthClientError(
      `name must be ${OAUTH_CLIENT_NAME_MIN}–${OAUTH_CLIENT_NAME_MAX} characters`,
    );
  }
  return trimmed;
}

export const oauthClientService = {
  async findActiveByClientId(clientId: string): Promise<OAuthClient | null> {
    return OAuthClient.findOne({ where: { clientId, status: 'active' } });
  },

  async findByClientId(clientId: string): Promise<OAuthClient | null> {
    return OAuthClient.findOne({ where: { clientId } });
  },

  async findByIdForOwner(id: string, ownerUserId: string): Promise<OAuthClient | null> {
    return OAuthClient.findOne({ where: { id, ownerUserId } });
  },

  async listForOwner(ownerUserId: string): Promise<OAuthClient[]> {
    return OAuthClient.findAll({
      where: { ownerUserId },
      order: [['createdAt', 'DESC']],
    });
  },

  async create(ownerUserId: string, body: Record<string, unknown>): Promise<OAuthClient> {
    const count = await OAuthClient.count({ where: { ownerUserId } });
    if (count >= OAUTH_MAX_CLIENTS_PER_USER) {
      throw new OAuthClientError(
        `at most ${OAUTH_MAX_CLIENTS_PER_USER} apps allowed`,
        400,
        'CLIENT_LIMIT',
      );
    }

    const name = normalizeName(body.name);
    const redirectUris = normalizeRedirectUris(body.redirectUris);
    const allowedScopes = normalizeAllowedScopes(body.allowedScopes ?? body.scopes);
    if (parseScopeBitsStored(allowedScopes) === 0n) {
      throw new OAuthClientError('at least one scope is required');
    }
    const singleGrant = Boolean(body.singleGrant);

    return OAuthClient.create({
      clientId: generateClientId(),
      ownerUserId,
      name,
      description:
        typeof body.description === 'string' ? body.description.trim().slice(0, 512) : null,
      homepageUrl:
        typeof body.homepageUrl === 'string' ? body.homepageUrl.trim().slice(0, 512) || null : null,
      privacyUrl:
        typeof body.privacyUrl === 'string' ? body.privacyUrl.trim().slice(0, 512) || null : null,
      redirectUris,
      allowedScopes,
      singleGrant,
      verified: false,
      status: 'active',
    });
  },

  async update(
    client: OAuthClient,
    body: Record<string, unknown>,
  ): Promise<OAuthClient> {
    if (body.name !== undefined) client.name = normalizeName(body.name);
    if (body.redirectUris !== undefined) {
      client.redirectUris = normalizeRedirectUris(body.redirectUris);
    }
    if (body.allowedScopes !== undefined || body.scopes !== undefined) {
      client.allowedScopes = normalizeAllowedScopes(body.allowedScopes ?? body.scopes);
    }
    if (body.singleGrant !== undefined) client.singleGrant = Boolean(body.singleGrant);
    if (body.description !== undefined) {
      client.description =
        typeof body.description === 'string' ? body.description.trim().slice(0, 512) : null;
    }
    if (body.homepageUrl !== undefined) {
      client.homepageUrl =
        typeof body.homepageUrl === 'string' ? body.homepageUrl.trim().slice(0, 512) || null : null;
    }
    if (body.privacyUrl !== undefined) {
      client.privacyUrl =
        typeof body.privacyUrl === 'string' ? body.privacyUrl.trim().slice(0, 512) || null : null;
    }
    await client.save();
    return client;
  },

  async delete(client: OAuthClient): Promise<void> {
    const grants = await OAuthGrant.findAll({ where: { clientId: client.clientId } });
    for (const grant of grants) {
      await OAuthAuthorizationCode.destroy({ where: { grantId: grant.id } });
      await OAuthRefreshToken.destroy({ where: { grantId: grant.id } });
      await grant.destroy();
    }
    await client.destroy();
  },

  async findByPk(id: string): Promise<OAuthClient | null> {
    return OAuthClient.findByPk(id);
  },

  async setStatus(clientIdRow: string, status: 'active' | 'frozen'): Promise<OAuthClient | null> {
    const client = await OAuthClient.findByPk(clientIdRow);
    if (!client) return null;
    client.status = status;
    await client.save();
    return client;
  },

  async setVerified(clientIdRow: string, verified: boolean): Promise<OAuthClient | null> {
    const client = await OAuthClient.findByPk(clientIdRow);
    if (!client) return null;
    client.verified = verified;
    await client.save();
    return client;
  },

  async listAllAdmin(opts: {
    limit?: number;
    offset?: number;
    q?: string | null;
  } = {}): Promise<{ apps: OAuthClient[]; total: number }> {
    const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 200);
    const offset = Math.max(Number(opts.offset) || 0, 0);
    const q = typeof opts.q === 'string' ? opts.q.trim() : '';

    const where: WhereOptions = {};
    if (q) {
      const like = `%${q.replace(/[%_]/g, '\\$&')}%`;
      const or: WhereOptions[] = [
        { name: { [Op.like]: like } },
        { clientId: { [Op.like]: like } },
        { '$owner.username$': { [Op.like]: like } },
      ];
      if (
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(q)
      ) {
        or.push({ id: q });
      }
      Object.assign(where, { [Op.or]: or });
    }

    const { rows, count } = await OAuthClient.findAndCountAll({
      where,
      order: [['createdAt', 'DESC']],
      limit,
      offset,
      distinct: true,
      col: 'id',
      include: [{ model: User, as: 'owner', attributes: ['id', 'username'], required: false }],
    });

    return { apps: rows, total: count };
  },

  clientPublicMeta(client: OAuthClient, ownerUsername?: string | null) {
    return {
      id: client.id,
      clientId: client.clientId,
      name: client.name,
      description: client.description ?? null,
      homepageUrl: client.homepageUrl ?? null,
      privacyUrl: client.privacyUrl ?? null,
      redirectUris: client.redirectUris,
      allowedScopes: parseScopeBitsStored(client.allowedScopes).toString(),
      singleGrant: client.singleGrant,
      verified: client.verified,
      status: client.status,
      createdAt: client.createdAt,
      ownerUsername: ownerUsername ?? null,
    };
  },
};
