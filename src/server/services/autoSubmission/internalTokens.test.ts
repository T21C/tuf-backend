import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptsInternalToken, readInternalTokens } from './internalTokens.js';

test('internal authentication accepts only the token for the incoming direction', () => {
  const tokens = readInternalTokens({
    AUTO_SUBMISSION_TO_TUF_TOKEN: 'a'.repeat(48),
    TUF_TO_AUTO_SUBMISSION_TOKEN: 'b'.repeat(48),
  });
  assert.ok(tokens);
  assert.equal(acceptsInternalToken(`Bearer ${tokens.incoming}`, tokens), true);
  for (const credential of [
    `Bearer ${tokens.outgoing}`,
    'Bearer eyJhbGciOiJIUzI1NiJ9.oauth.signature',
    'session=site-cookie',
    'Bearer ',
    undefined,
  ]) {
    assert.equal(acceptsInternalToken(credential, tokens), false);
  }
});

test('missing, shared, malformed, and legacy configuration fail closed', () => {
  for (const env of [
    {},
    { TUF_SUBMISSION_SERVICE_SECRET: 'a'.repeat(48) },
    { AUTO_SUBMISSION_TO_TUF_TOKEN: 'a'.repeat(48) },
    { AUTO_SUBMISSION_TO_TUF_TOKEN: 'a'.repeat(48), TUF_TO_AUTO_SUBMISSION_TOKEN: 'a'.repeat(48) },
    { AUTO_SUBMISSION_TO_TUF_TOKEN: 'a'.repeat(48), TUF_TO_AUTO_SUBMISSION_TOKEN: ' '.repeat(48) },
  ]) {
    assert.equal(readInternalTokens(env), null);
  }
});
