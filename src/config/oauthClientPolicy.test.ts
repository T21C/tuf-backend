import {test} from 'node:test';
import assert from 'node:assert/strict';
import {grantableScopesForClient, isAutoSubmissionClient} from './oauthClientPolicy.js';
import {parseScopeString, V1_GRANTABLE_MASK} from './oauthScopes.js';

const OFFICIAL_CLIENT_ID = '1dc9ff206f5301c9e7ef4ba9b209c7c7';

test('submission scope 65537 is grantable only for the configured official client', t => {
  const previous = process.env.TUF_AUTO_SUBMISSION_OAUTH_CLIENT_ID;
  t.after(() => {
    if (previous === undefined) delete process.env.TUF_AUTO_SUBMISSION_OAUTH_CLIENT_ID;
    else process.env.TUF_AUTO_SUBMISSION_OAUTH_CLIENT_ID = previous;
  });

  delete process.env.TUF_AUTO_SUBMISSION_OAUTH_CLIENT_ID;
  assert.equal(grantableScopesForClient(OFFICIAL_CLIENT_ID), V1_GRANTABLE_MASK);
  assert.equal(isAutoSubmissionClient(OFFICIAL_CLIENT_ID), false);

  process.env.TUF_AUTO_SUBMISSION_OAUTH_CLIENT_ID = OFFICIAL_CLIENT_ID;
  const officialMask = grantableScopesForClient(OFFICIAL_CLIENT_ID);
  assert.equal(officialMask, 65537n);
  assert.equal(isAutoSubmissionClient(OFFICIAL_CLIENT_ID), true);
  assert.equal(grantableScopesForClient('another-public-client'), V1_GRANTABLE_MASK);

  assert.deepEqual(parseScopeString('65537', officialMask), {
    ok: true,
    bits: 65537n,
    names: ['User.Read.Public', 'User.Submission.Create'],
  });
  assert.deepEqual(parseScopeString('65537', V1_GRANTABLE_MASK), {
    ok: false,
    error: 'scope contains non-grantable bits',
  });
});
