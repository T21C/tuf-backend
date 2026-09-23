import {test, type TestContext} from 'node:test';
import assert from 'node:assert/strict';

// OAuth configuration is loaded when authorization.ts imports OAuthTokenService.
// Keep these tests independent of local or CI secrets before importing app modules.
process.env.JWT_SECRET = 'auto-submission-test-only-jwt-secret';
process.env.OAUTH_JWT_SECRET = 'auto-submission-test-only-oauth-jwt-secret';

const [
  {default: User},
  {default: OAuthGrant},
  {default: OAuthClient},
  {permissionFlags},
  {requireSubmissionAuthorization},
] = await Promise.all([
  import('@/models/auth/User.js'),
  import('@/models/oauth/OAuthGrant.js'),
  import('@/models/oauth/OAuthClient.js'),
  import('@/config/constants.js'),
  import('./authorization.js'),
]);

const ownerId = '670cac2c-8175-46a6-87f7-b92741d4499f';
const grantId = 'e2cff0bb-9d9e-412a-8416-a453352b3bf2';
const clientId = 'operator-test-public-client';

function mockIdentity(t: TestContext) {
  t.mock.method(OAuthGrant, 'findByPk', async () => ({
    id: grantId,
    userId: ownerId,
    clientId,
    scopeBits: '65537',
    revokedAt: null,
  }) as never);
  t.mock.method(OAuthClient, 'findOne', async () => ({
    clientId,
    allowedScopes: '65537',
    status: 'active',
  }) as never);
  t.mock.method(User, 'findByPk', async () => ({
    id: ownerId,
    username: 'impl.dev',
    nickname: 'impl',
    status: 'active',
    deletionScheduledAt: null,
    playerId: 7410,
    player: {bannedUntil: null},
    permissionFlags: permissionFlags.EMAIL_VERIFIED,
  }) as never);
}

function withEnv(t: TestContext, values: Record<string, string | undefined>) {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test('mutation authorization reports stable denial while identity requirements pass', async t => {
  withEnv(t, {
    TUF_AUTO_SUBMISSION_OAUTH_CLIENT_ID: clientId,
    AUTO_SUBMISSION_ENABLED: 'false',
    AUTO_SUBMISSION_TRUSTED_USER_IDS: ownerId,
  });
  mockIdentity(t);

  await assert.rejects(
    requireSubmissionAuthorization(ownerId, grantId),
    (error: unknown) => {
      assert.equal((error as {code?: number}).code, 403);
      assert.equal((error as {denialReason?: string}).denialReason, 'auto_submission_disabled');
      return true;
    },
  );
});

test('authorized tester can pass the final BE mutation gate', async t => {
  withEnv(t, {
    TUF_AUTO_SUBMISSION_OAUTH_CLIENT_ID: clientId,
    AUTO_SUBMISSION_ENABLED: 'true',
    AUTO_SUBMISSION_TRUSTED_USER_IDS: ownerId,
  });
  mockIdentity(t);

  const identity = await requireSubmissionAuthorization(ownerId, grantId);
  assert.equal(identity.owner_id, ownerId);
  assert.equal(identity.client_id, clientId);
  assert.equal(identity.can_submit, true);
  assert.equal(identity.denial_reason, null);
});

test('replay tester authority still rejects revoked OAuth grants at final registration', async t => {
  withEnv(t, {
    TUF_AUTO_SUBMISSION_OAUTH_CLIENT_ID: clientId,
    AUTO_SUBMISSION_ENABLED: 'true',
    AUTO_SUBMISSION_TESTER_AUTHORITY: 'replay',
    AUTO_SUBMISSION_TRUSTED_USER_IDS: undefined,
  });
  mockIdentity(t);
  assert.equal((await requireSubmissionAuthorization(ownerId, grantId)).can_submit, true);
  t.mock.method(OAuthGrant, 'findByPk', async () => ({
    id: grantId, userId: ownerId, clientId, scopeBits: '65537', revokedAt: new Date(),
  }) as never);
  await assert.rejects(requireSubmissionAuthorization(ownerId, grantId));
});

test('replay tester authority still rejects unavailable accounts', async t => {
  withEnv(t, {
    TUF_AUTO_SUBMISSION_OAUTH_CLIENT_ID: clientId,
    AUTO_SUBMISSION_ENABLED: 'true',
    AUTO_SUBMISSION_TESTER_AUTHORITY: 'replay',
  });
  mockIdentity(t);
  t.mock.method(User, 'findByPk', async () => null);
  await assert.rejects(requireSubmissionAuthorization(ownerId, grantId));
});
