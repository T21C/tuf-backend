import { oauthScopeFlags, V1_GRANTABLE_MASK } from './oauthScopes.js';

export function isAutoSubmissionClient(clientId: string): boolean {
  const official = process.env.TUF_AUTO_SUBMISSION_OAUTH_CLIENT_ID;
  return Boolean(official && clientId === official);
}

export function grantableScopesForClient(clientId: string): bigint {
  return isAutoSubmissionClient(clientId)
    ? V1_GRANTABLE_MASK | oauthScopeFlags.USER_SUBMISSION_CREATE
    : V1_GRANTABLE_MASK;
}
