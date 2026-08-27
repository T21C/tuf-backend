import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SUPER_ADMIN_PROOF_MAX_SKEW_SEC,
  createSuperAdminProof,
  verifySuperAdminProof,
} from './superAdminProof.js';

const secret = 'test-super-admin-secret';
const base = {
  secret,
  userId: 'user-1',
  username: 'alice',
  method: 'POST',
  path: '/v2/admin/backup',
  unixSeconds: 1_700_000_000,
};

test('matching user, method, path, and timestamp accepts', () => {
  const proof = createSuperAdminProof(base);
  assert.equal(
    verifySuperAdminProof({
      proof,
      secret,
      userId: base.userId,
      username: base.username,
      method: base.method,
      path: base.path,
      now: base.unixSeconds,
    }),
    true,
  );
});

test('other userId or username rejects', () => {
  const proof = createSuperAdminProof(base);
  assert.equal(
    verifySuperAdminProof({
      proof,
      secret,
      userId: 'user-2',
      username: base.username,
      method: base.method,
      path: base.path,
      now: base.unixSeconds,
    }),
    false,
  );
  assert.equal(
    verifySuperAdminProof({
      proof,
      secret,
      userId: base.userId,
      username: 'bob',
      method: base.method,
      path: base.path,
      now: base.unixSeconds,
    }),
    false,
  );
});

test('other method or path rejects', () => {
  const proof = createSuperAdminProof(base);
  assert.equal(
    verifySuperAdminProof({
      proof,
      secret,
      userId: base.userId,
      username: base.username,
      method: 'DELETE',
      path: base.path,
      now: base.unixSeconds,
    }),
    false,
  );
  assert.equal(
    verifySuperAdminProof({
      proof,
      secret,
      userId: base.userId,
      username: base.username,
      method: base.method,
      path: '/v2/admin/verify-password',
      now: base.unixSeconds,
    }),
    false,
  );
});

test('expired timestamp rejects', () => {
  const proof = createSuperAdminProof(base);
  assert.equal(
    verifySuperAdminProof({
      proof,
      secret,
      userId: base.userId,
      username: base.username,
      method: base.method,
      path: base.path,
      now: base.unixSeconds + SUPER_ADMIN_PROOF_MAX_SKEW_SEC + 1,
    }),
    false,
  );
});

test('wrong key rejects', () => {
  const proof = createSuperAdminProof(base);
  assert.equal(
    verifySuperAdminProof({
      proof,
      secret: 'other-secret',
      userId: base.userId,
      username: base.username,
      method: base.method,
      path: base.path,
      now: base.unixSeconds,
    }),
    false,
  );
});

test('path query string is ignored so client and server agree', () => {
  const proof = createSuperAdminProof({
    ...base,
    path: '/v2/admin/verify-password?origin=difficulty',
  });
  assert.equal(
    verifySuperAdminProof({
      proof,
      secret,
      userId: base.userId,
      username: base.username,
      method: 'HEAD',
      path: '/v2/admin/verify-password',
      now: base.unixSeconds,
    }),
    false,
  );

  const headProof = createSuperAdminProof({
    ...base,
    method: 'head',
    path: '/v2/admin/verify-password?origin=difficulty',
  });
  assert.equal(
    verifySuperAdminProof({
      proof: headProof,
      secret,
      userId: base.userId,
      username: base.username,
      method: 'HEAD',
      path: '/v2/admin/verify-password',
      now: base.unixSeconds,
    }),
    true,
  );
});
