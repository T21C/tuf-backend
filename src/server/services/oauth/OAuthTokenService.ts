import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { Op } from 'sequelize';
import {
  OAUTH_ACCESS_TOKEN_TTL_SEC,
  OAUTH_AUTH_CODE_TTL_SEC,
  OAUTH_CONSENT_PENDING_TTL_SEC,
  OAUTH_JWT_SECRET,
  OAUTH_REFRESH_TOKEN_TTL_SEC,
  OAUTH_TOKEN_AUDIENCE,
  OAUTH_TOKEN_USE_ACCESS,
} from '@/config/oauth.config.js';
import {
  hasOAuthScope,
  parseScopeBitsStored,
  parseScopeString,
  scopeBitsToSpaceSeparated,
  V1_GRANTABLE_MASK,
  oauthScopeFlags,
} from '@/config/oauthScopes.js';
import OAuthAuthorizationCode from '@/models/oauth/OAuthAuthorizationCode.js';
import OAuthClient from '@/models/oauth/OAuthClient.js';
import OAuthGrant from '@/models/oauth/OAuthGrant.js';
import OAuthRefreshToken from '@/models/oauth/OAuthRefreshToken.js';
import User from '@/models/auth/User.js';
import { logger } from '@/server/services/core/LoggerService.js';
import {
  isRedirectUriAllowed,
  oauthClientService,
} from './OAuthClientService.js';

export class OAuthAsError extends Error {
  constructor(
    message: string,
    public status: number = 400,
    public errorCode: string = 'invalid_request',
    /** When true, do not redirect error to client redirect_uri */
    public safeToRedirect = true,
  ) {
    super(message);
    this.name = 'OAuthAsError';
  }
}

function hashOpaque(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function pkceChallengeFromVerifier(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

export interface AuthorizeRequest {
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  responseType: string;
}

export interface ConsentPendingPayload {
  clientId: string;
  redirectUri: string;
  scopeBits: string;
  state: string;
  codeChallenge: string;
  userId: string;
}

export function verifyPkce(verifier: string, challenge: string): boolean {
  if (!verifier || verifier.length < 43 || verifier.length > 128) return false;
  if (!/^[A-Za-z0-9\-._~]+$/.test(verifier)) return false;
  return pkceChallengeFromVerifier(verifier) === challenge;
}

export function signConsentPending(payload: ConsentPendingPayload): string {
  return jwt.sign(
    { ...payload, typ: 'oauth_consent' },
    OAUTH_JWT_SECRET,
    { expiresIn: OAUTH_CONSENT_PENDING_TTL_SEC },
  );
}

export function verifyConsentPending(token: string): ConsentPendingPayload | null {
  try {
    const decoded = jwt.verify(token, OAUTH_JWT_SECRET) as ConsentPendingPayload & {
      typ?: string;
    };
    if (decoded.typ !== 'oauth_consent') return null;
    if (!decoded.clientId || !decoded.userId || !decoded.redirectUri) return null;
    return decoded;
  } catch {
    return null;
  }
}

export interface OAuthAccessClaims {
  sub: string;
  client_id: string;
  scope: string;
  scope_bits: string;
  gid: string;
  token_use: typeof OAUTH_TOKEN_USE_ACCESS;
  aud: typeof OAUTH_TOKEN_AUDIENCE;
  iat?: number;
  exp?: number;
}

export function mintOAuthAccessToken(args: {
  userId: string;
  clientId: string;
  grantId: string;
  scopeBits: bigint;
}): string {
  const claims: OAuthAccessClaims = {
    sub: args.userId,
    client_id: args.clientId,
    scope: scopeBitsToSpaceSeparated(args.scopeBits),
    scope_bits: args.scopeBits.toString(),
    gid: args.grantId,
    token_use: OAUTH_TOKEN_USE_ACCESS,
    aud: OAUTH_TOKEN_AUDIENCE,
  };
  return jwt.sign(claims, OAUTH_JWT_SECRET, {
    expiresIn: OAUTH_ACCESS_TOKEN_TTL_SEC,
  });
}

export function verifyOAuthAccessToken(token: string): OAuthAccessClaims | null {
  try {
    const decoded = jwt.verify(token, OAUTH_JWT_SECRET) as OAuthAccessClaims;
    if (decoded.token_use !== OAUTH_TOKEN_USE_ACCESS) return null;
    if (decoded.aud !== OAUTH_TOKEN_AUDIENCE) return null;
    if (!decoded.sub || !decoded.client_id || !decoded.gid) return null;
    return decoded;
  } catch {
    return null;
  }
}

async function requireActiveClient(clientId: string): Promise<OAuthClient> {
  const client = await oauthClientService.findByClientId(clientId);
  if (!client) {
    throw new OAuthAsError('Unknown client', 400, 'invalid_client', false);
  }
  if (client.status !== 'active') {
    throw new OAuthAsError('Client is frozen', 400, 'unauthorized_client', false);
  }
  return client;
}

export function validateAuthorizeQuery(query: Record<string, unknown>): AuthorizeRequest {
  const responseType = String(query.response_type ?? '');
  const clientId = String(query.client_id ?? '');
  const redirectUri = String(query.redirect_uri ?? '');
  const scope = String(query.scope ?? '');
  const state = String(query.state ?? '');
  const codeChallenge = String(query.code_challenge ?? '');
  const codeChallengeMethod = String(query.code_challenge_method ?? '');

  if (responseType !== 'code') {
    throw new OAuthAsError('response_type must be code', 400, 'unsupported_response_type', false);
  }
  if (!clientId) throw new OAuthAsError('client_id required', 400, 'invalid_request', false);
  if (!redirectUri) throw new OAuthAsError('redirect_uri required', 400, 'invalid_request', false);
  if (!state) throw new OAuthAsError('state required', 400, 'invalid_request', false);
  if (!codeChallenge) throw new OAuthAsError('code_challenge required', 400, 'invalid_request', false);
  if (codeChallengeMethod !== 'S256') {
    throw new OAuthAsError('code_challenge_method must be S256', 400, 'invalid_request', false);
  }
  if (!scope) throw new OAuthAsError('scope required', 400, 'invalid_request', false);

  return {
    clientId,
    redirectUri,
    scope,
    state,
    codeChallenge,
    codeChallengeMethod,
    responseType,
  };
}

export async function validateAuthorizeAgainstClient(
  req: AuthorizeRequest,
): Promise<{ client: OAuthClient; scopeBits: bigint; scopeNames: string[] }> {
  const client = await requireActiveClient(req.clientId);
  if (!isRedirectUriAllowed(client.redirectUris, req.redirectUri)) {
    throw new OAuthAsError('redirect_uri mismatch', 400, 'invalid_request', false);
  }
  const parsed = parseScopeString(req.scope);
  if (!parsed.ok) {
    throw new OAuthAsError(parsed.error, 400, 'invalid_scope', true);
  }
  const allowed = parseScopeBitsStored(client.allowedScopes);
  if ((parsed.bits & ~allowed) !== 0n) {
    throw new OAuthAsError('requested scope exceeds client allowlist', 400, 'invalid_scope', true);
  }
  if ((parsed.bits & ~V1_GRANTABLE_MASK) !== 0n) {
    throw new OAuthAsError('scope not grantable', 400, 'invalid_scope', true);
  }
  return { client, scopeBits: parsed.bits, scopeNames: parsed.names };
}

export async function findActiveGrant(
  userId: string,
  clientId: string,
): Promise<OAuthGrant | null> {
  return OAuthGrant.findOne({
    where: {
      userId,
      clientId,
      revokedAt: null,
    },
    order: [['updatedAt', 'DESC']],
  });
}

export async function upsertGrant(args: {
  userId: string;
  client: OAuthClient;
  scopeBits: bigint;
}): Promise<OAuthGrant> {
  const existing = await findActiveGrant(args.userId, args.client.clientId);
  if (existing) {
    existing.scopeBits = args.scopeBits.toString();
    existing.singleGrant = args.client.singleGrant;
    await existing.save();
    return existing;
  }
  return OAuthGrant.create({
    userId: args.userId,
    clientId: args.client.clientId,
    scopeBits: args.scopeBits.toString(),
    singleGrant: args.client.singleGrant,
  });
}

export async function issueAuthorizationCode(args: {
  userId: string;
  client: OAuthClient;
  redirectUri: string;
  scopeBits: bigint;
  codeChallenge: string;
}): Promise<{ code: string; grant: OAuthGrant }> {
  const user = await User.findByPk(args.userId, {
    attributes: ['id', 'playerId'],
  });
  if (!user?.playerId) {
    logger.error('oauth_authorize_missing_player_id', { userId: args.userId });
    throw new OAuthAsError(
      'Account is missing a linked player profile',
      400,
      'access_denied',
      true,
    );
  }

  const grant = await upsertGrant({
    userId: args.userId,
    client: args.client,
    scopeBits: args.scopeBits,
  });

  if (args.client.singleGrant || grant.singleGrant) {
    await OAuthRefreshToken.update(
      { revokedAt: new Date() },
      { where: { grantId: grant.id, revokedAt: null } },
    );
  }

  const code = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + OAUTH_AUTH_CODE_TTL_SEC * 1000);
  await OAuthAuthorizationCode.create({
    codeHash: hashOpaque(code),
    clientId: args.client.clientId,
    userId: args.userId,
    grantId: grant.id,
    redirectUri: args.redirectUri,
    scopeBits: args.scopeBits.toString(),
    codeChallenge: args.codeChallenge,
    expiresAt,
    createdAt: new Date(),
  });

  return { code, grant };
}

export function scopesMatch(a: bigint, b: bigint): boolean {
  return a === b;
}

export async function grantNeedsConsent(
  userId: string,
  clientId: string,
  requestedBits: bigint,
): Promise<boolean> {
  const grant = await findActiveGrant(userId, clientId);
  if (!grant) return true;
  return !scopesMatch(parseScopeBitsStored(grant.scopeBits), requestedBits);
}

async function createRefreshToken(args: {
  grantId: string;
  userAgent?: string;
  ip?: string;
}): Promise<string> {
  const token = crypto.randomBytes(32).toString('hex');
  await OAuthRefreshToken.create({
    grantId: args.grantId,
    tokenHash: hashOpaque(token),
    userAgent: args.userAgent ?? null,
    ip: args.ip ?? null,
    expiresAt: new Date(Date.now() + OAUTH_REFRESH_TOKEN_TTL_SEC * 1000),
    createdAt: new Date(),
  });
  return token;
}

async function revokeGrantFamily(grantId: string): Promise<void> {
  const now = new Date();
  await OAuthGrant.update({ revokedAt: now }, { where: { id: grantId, revokedAt: null } });
  await OAuthRefreshToken.update(
    { revokedAt: now },
    { where: { grantId, revokedAt: null } },
  );
}

export async function exchangeAuthorizationCode(args: {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
  userAgent?: string;
  ip?: string;
}): Promise<{
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}> {
  const client = await requireActiveClient(args.clientId);
  const codeHash = hashOpaque(args.code);

  const row = await OAuthAuthorizationCode.findOne({ where: { codeHash } });
  if (!row) {
    throw new OAuthAsError('Invalid authorization code', 400, 'invalid_grant');
  }

  if (row.consumedAt) {
    logger.warn('oauth_auth_code_reuse', { clientId: args.clientId, grantId: row.grantId });
    await revokeGrantFamily(row.grantId);
    throw new OAuthAsError('Authorization code already used', 400, 'invalid_grant');
  }

  if (row.expiresAt.getTime() < Date.now()) {
    throw new OAuthAsError('Authorization code expired', 400, 'invalid_grant');
  }

  if (row.clientId !== args.clientId) {
    throw new OAuthAsError('client_id mismatch', 400, 'invalid_grant');
  }
  if (row.redirectUri !== args.redirectUri) {
    throw new OAuthAsError('redirect_uri mismatch', 400, 'invalid_grant');
  }
  if (!verifyPkce(args.codeVerifier, row.codeChallenge)) {
    throw new OAuthAsError('PKCE verification failed', 400, 'invalid_grant');
  }

  const [affected] = await OAuthAuthorizationCode.update(
    { consumedAt: new Date() },
    {
      where: {
        id: row.id,
        consumedAt: null,
        expiresAt: { [Op.gt]: new Date() },
      },
    },
  );
  if (affected !== 1) {
    await revokeGrantFamily(row.grantId);
    throw new OAuthAsError('Authorization code already used', 400, 'invalid_grant');
  }

  const grant = await OAuthGrant.findByPk(row.grantId);
  if (!grant || grant.revokedAt) {
    throw new OAuthAsError('Grant revoked', 400, 'invalid_grant');
  }

  const scopeBits = parseScopeBitsStored(row.scopeBits);
  const access_token = mintOAuthAccessToken({
    userId: row.userId,
    clientId: client.clientId,
    grantId: grant.id,
    scopeBits,
  });
  const refresh_token = await createRefreshToken({
    grantId: grant.id,
    userAgent: args.userAgent,
    ip: args.ip,
  });

  return {
    access_token,
    token_type: 'Bearer',
    expires_in: OAUTH_ACCESS_TOKEN_TTL_SEC,
    refresh_token,
    scope: scopeBitsToSpaceSeparated(scopeBits),
  };
}

export async function refreshAccessToken(args: {
  refreshToken: string;
  clientId: string;
  userAgent?: string;
  ip?: string;
}): Promise<{
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}> {
  await requireActiveClient(args.clientId);
  const tokenHash = hashOpaque(args.refreshToken);
  const record = await OAuthRefreshToken.findOne({
    where: { tokenHash },
    include: [{ model: OAuthGrant, as: 'grant' }],
  });

  if (!record) {
    throw new OAuthAsError('Invalid refresh token', 400, 'invalid_grant');
  }

  const grant = (record as OAuthRefreshToken & { grant?: OAuthGrant }).grant;
  if (!grant) {
    throw new OAuthAsError('Invalid refresh token', 400, 'invalid_grant');
  }

  if (grant.clientId !== args.clientId) {
    throw new OAuthAsError('client_id mismatch', 400, 'invalid_grant');
  }

  if (record.revokedAt || grant.revokedAt) {
    // Reuse of revoked token → kill family
    if (record.revokedAt && record.replacedBy) {
      logger.warn('oauth_refresh_reuse', { grantId: grant.id, clientId: args.clientId });
      await revokeGrantFamily(grant.id);
    }
    throw new OAuthAsError('Refresh token revoked', 400, 'invalid_grant');
  }

  if (record.expiresAt.getTime() < Date.now()) {
    throw new OAuthAsError('Refresh token expired', 400, 'invalid_grant');
  }

  const newPlain = crypto.randomBytes(32).toString('hex');
  const newHash = hashOpaque(newPlain);
  const expiresAt = new Date(Date.now() + OAUTH_REFRESH_TOKEN_TTL_SEC * 1000);
  const newRow = await OAuthRefreshToken.create({
    grantId: grant.id,
    tokenHash: newHash,
    userAgent: args.userAgent ?? record.userAgent,
    ip: args.ip ?? record.ip,
    expiresAt,
    createdAt: new Date(),
  });

  await record.update({
    revokedAt: new Date(),
    replacedBy: newRow.id,
  });

  const scopeBits = parseScopeBitsStored(grant.scopeBits);
  const access_token = mintOAuthAccessToken({
    userId: grant.userId,
    clientId: grant.clientId,
    grantId: grant.id,
    scopeBits,
  });

  return {
    access_token,
    token_type: 'Bearer',
    expires_in: OAUTH_ACCESS_TOKEN_TTL_SEC,
    refresh_token: newPlain,
    scope: scopeBitsToSpaceSeparated(scopeBits),
  };
}

export async function revokeToken(args: {
  token: string;
  clientId?: string;
}): Promise<void> {
  const tokenHash = hashOpaque(args.token);

  const refresh = await OAuthRefreshToken.findOne({ where: { tokenHash } });
  if (refresh) {
    const grant = await OAuthGrant.findByPk(refresh.grantId);
    if (args.clientId && grant && grant.clientId !== args.clientId) {
      return;
    }
    await revokeGrantFamily(refresh.grantId);
    return;
  }

  const access = verifyOAuthAccessToken(args.token);
  if (access) {
    if (args.clientId && access.client_id !== args.clientId) return;
    await revokeGrantFamily(access.gid);
  }
}

export async function revokeGrantById(grantId: string, userId: string): Promise<boolean> {
  const grant = await OAuthGrant.findOne({ where: { id: grantId, userId } });
  if (!grant || grant.revokedAt) return false;
  await revokeGrantFamily(grant.id);
  return true;
}

export async function listGrantsForUser(userId: string) {
  const grants = await OAuthGrant.findAll({
    where: { userId, revokedAt: null },
    order: [['updatedAt', 'DESC']],
  });
  const clientIds = [...new Set(grants.map((g) => g.clientId))];
  const clients = await OAuthClient.findAll({
    where: { clientId: { [Op.in]: clientIds } },
  });
  const byClient = new Map(clients.map((c) => [c.clientId, c]));
  return grants.map((g) => {
    const client = byClient.get(g.clientId);
    return {
      id: g.id,
      clientId: g.clientId,
      scope: scopeBitsToSpaceSeparated(parseScopeBitsStored(g.scopeBits)),
      singleGrant: g.singleGrant,
      createdAt: g.createdAt,
      updatedAt: g.updatedAt,
      client: client
        ? {
            name: client.name,
            verified: client.verified,
            homepageUrl: client.homepageUrl,
            iconUrl: client.iconUrl ?? null,
            status: client.status,
          }
        : null,
    };
  });
}

export async function buildUserResource(userId: string, scopeBits: bigint) {
  const user = await User.findByPk(userId, {
    attributes: ['id', 'username', 'email', 'playerId', 'avatarUrl', 'nickname'],
  });
  if (!user) return null;
  const dto: Record<string, unknown> = {
    userId: user.id,
    username: user.username,
    playerId: user.playerId,
    nickname: user.nickname ?? null,
    avatarUrl: user.avatarUrl ?? null,
  };
  if (hasOAuthScope(scopeBits, oauthScopeFlags.USER_READ_EMAIL)) {
    dto.email = user.email ?? null;
  }
  return dto;
}

export async function isGrantActive(grantId: string): Promise<boolean> {
  const grant = await OAuthGrant.findByPk(grantId, { attributes: ['id', 'revokedAt'] });
  return Boolean(grant && !grant.revokedAt);
}
