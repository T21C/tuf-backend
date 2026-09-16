import type { Transaction } from 'sequelize';
import User from '@/models/auth/User.js';
import Player from '@/models/players/Player.js';
import OAuthGrant from '@/models/oauth/OAuthGrant.js';
import OAuthClient from '@/models/oauth/OAuthClient.js';
import { isAutoSubmissionClient } from '@/config/oauthClientPolicy.js';
import { hasOAuthScope, oauthScopeFlags, parseScopeBitsStored } from '@/config/oauthScopes.js';
import { verifyOAuthAccessToken } from '@/server/services/oauth/OAuthTokenService.js';
import { gateSubmissionUser } from '@/server/services/submissions/submissionPermission.js';
import { formError } from '@/server/services/submissions/submissionErrors.js';
import { getAutoSubmissionEligibility } from './policy.js';

/** Verifies the existing OAuth/account identity requirements without tester eligibility. */
export async function requireSubmissionIdentity(ownerId: string, grantId: string, transaction?: Transaction) {
  const grant = await OAuthGrant.findByPk(grantId, { transaction, lock: transaction?.LOCK.UPDATE });
  if (!grant || grant.revokedAt || grant.userId !== ownerId || !isAutoSubmissionClient(grant.clientId)
      || !hasOAuthScope(parseScopeBitsStored(grant.scopeBits), oauthScopeFlags.USER_SUBMISSION_CREATE)) {
    throw formError.unauth('Auto submission permission is no longer active');
  }
  const client = await OAuthClient.findOne({ where: { clientId: grant.clientId, status: 'active' }, transaction, lock: transaction?.LOCK.UPDATE });
  if (!client || !hasOAuthScope(parseScopeBitsStored(client.allowedScopes), oauthScopeFlags.USER_SUBMISSION_CREATE)) {
    throw formError.unauth('Auto submission client is unavailable');
  }
  const user = await User.findByPk(ownerId, { include: [{ model: Player, as: 'player' }], transaction });
  if (!user || user.status !== 'active' || user.deletionScheduledAt || !user.playerId || !user.player) {
    throw formError.forbid('Account cannot submit');
  }
  gateSubmissionUser(user);
  return {
    owner_id: user.id,
    grant_id: grant.id,
    client_id: client.clientId,
    username: user.username,
    nickname: user.nickname ?? null,
  };
}

/** Mutation gate. Call inside the final TUF registration transaction as well as at upload authorization. */
export async function requireSubmissionAuthorization(ownerId: string, grantId: string, transaction?: Transaction) {
  const identity = await requireSubmissionIdentity(ownerId, grantId, transaction);
  const eligibility = getAutoSubmissionEligibility(identity.owner_id);
  if (!eligibility.can_submit) {
    const message = eligibility.denial_reason === 'auto_submission_disabled'
      ? 'Auto submission is temporarily unavailable'
      : 'This TUF account is not enabled for auto submission';
    throw formError.forbid(message, eligibility.denial_reason);
  }
  return { ...identity, ...eligibility };
}

export async function identifySubmissionAccount(token: string) {
  const claims = verifyOAuthAccessToken(token);
  if (!claims || !isAutoSubmissionClient(claims.client_id)
      || !hasOAuthScope(parseScopeBitsStored(claims.scope_bits), oauthScopeFlags.USER_SUBMISSION_CREATE)) {
    throw formError.unauth('Auto submission OAuth token required');
  }
  const identity = await requireSubmissionIdentity(claims.sub, claims.gid);
  if (identity.client_id !== claims.client_id) throw formError.unauth();
  return {
    ...identity,
    ...getAutoSubmissionEligibility(identity.owner_id),
    expires_at: claims.exp,
  };
}
