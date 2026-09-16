import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTO_SUBMISSION_OPERATOR_DEFAULTS,
  checkOAuthAppSettings,
  lookupTrustedTester,
  makeAutoSubmissionSetupPlan,
  makePlayerLookupUrl,
  runOperatorCommand,
} from './autoSubmissionOperator.js';

test('public lookup is a plain GET and verifies both player and account identity', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    return new Response(JSON.stringify({
      id: 7410,
      name: 'impl',
      user: {
        id: AUTO_SUBMISSION_OPERATOR_DEFAULTS.testerUserId,
        username: 'impl.dev',
        playerId: 7410,
      },
    }), {status: 200, headers: {'content-type': 'application/json'}});
  };

  const result = await lookupTrustedTester({
    playerId: 7410,
    username: 'impl.dev',
    fetchImpl,
  });
  assert.equal(requestUrl, 'https://api.tuforums.com/v2/database/players/7410');
  assert.equal(requestInit?.method, 'GET');
  assert.equal(requestInit?.redirect, 'error');
  assert.equal(new Headers(requestInit?.headers).has('authorization'), false);
  assert.deepEqual(result, {
    user_id: AUTO_SUBMISSION_OPERATOR_DEFAULTS.testerUserId,
    username: 'impl.dev',
    player_id: 7410,
    player_name: 'impl',
    source_url: requestUrl,
  });
});

test('public lookup rejects mismatched username and malformed account UUID', async () => {
  const mismatchFetch: typeof fetch = async () => new Response(JSON.stringify({
    id: 7410,
    user: {id: AUTO_SUBMISSION_OPERATOR_DEFAULTS.testerUserId, username: 'someone.else', playerId: 7410},
  }), {status: 200});
  await assert.rejects(lookupTrustedTester({playerId: 7410, username: 'impl.dev', fetchImpl: mismatchFetch}), /username did not match/);

  const invalidUuidFetch: typeof fetch = async () => new Response(JSON.stringify({
    id: 7410,
    user: {id: 'numeric-player-id-is-not-a-user-uuid', username: 'impl.dev', playerId: 7410},
  }), {status: 200});
  await assert.rejects(lookupTrustedTester({playerId: 7410, username: 'impl.dev', fetchImpl: invalidUuidFetch}), /invalid connected user UUID/);
});

test('dry-run lookup and plan never issue setup mutations or require secrets', async () => {
  const dryRun = await runOperatorCommand([
    'lookup', '--player-id', '7410', '--username', 'impl.dev', '--dry-run',
  ]) as {mode: string; method: string; authorization_header: boolean; result: string};
  assert.equal(dryRun.mode, 'dry_run');
  assert.equal(dryRun.method, 'GET');
  assert.equal(dryRun.authorization_header, false);
  assert.equal(dryRun.result, 'No request was made.');

  const plan = makeAutoSubmissionSetupPlan();
  assert.equal(plan.mode, 'proposal_only');
  assert.equal(plan.backend_environment.AUTO_SUBMISSION_ENABLED, 'false');
  assert.equal(plan.backend_environment.AUTO_SUBMISSION_TRUSTED_USER_IDS, AUTO_SUBMISSION_OPERATOR_DEFAULTS.testerUserId);
  assert.equal(plan.backend_environment.TUF_AUTO_SUBMISSION_OAUTH_CLIENT_ID, AUTO_SUBMISSION_OPERATOR_DEFAULTS.oauthClientId);
  assert.equal(plan.replay_runtime_environment.AUTO_SUBMISSION_API_URL, 'https://tufreplay-auto.impl1113.dev');
  assert.equal(plan.oauth_app_checklist.redirect_uri, 'https://tufreplay-auto.impl1113.dev/oauth/callback');
  assert.equal(plan.oauth_app_checklist.allowed_scope_bits, '65537');
  assert.match(plan.note, /no file is written/);
  assert.throws(() => makeAutoSubmissionSetupPlan({enabled: true, clientId: 'other-app'}), /differs from the official/);
  assert.throws(() => makeAutoSubmissionSetupPlan({redirectUri: 'https://other.example/callback'}), /differs from the registered/);
});

test('OAuth check validates exact public app identity, callback, and scope', () => {
  assert.deepEqual(checkOAuthAppSettings({
    clientId: AUTO_SUBMISSION_OPERATOR_DEFAULTS.oauthClientId,
    redirectUri: AUTO_SUBMISSION_OPERATOR_DEFAULTS.oauthRedirectUri,
    allowedScopeBits: AUTO_SUBMISSION_OPERATOR_DEFAULTS.oauthAllowedScopeBits,
  }), {
    matches_official_app: true,
    client_id: AUTO_SUBMISSION_OPERATOR_DEFAULTS.oauthClientId,
    redirect_uri: AUTO_SUBMISSION_OPERATOR_DEFAULTS.oauthRedirectUri,
    allowed_scope_bits: '65537',
    authorization_code_pkce: 'S256 required by TUF OAuth server',
    public_client: true,
  });
  assert.throws(() => checkOAuthAppSettings({
    clientId: AUTO_SUBMISSION_OPERATOR_DEFAULTS.oauthClientId,
    redirectUri: AUTO_SUBMISSION_OPERATOR_DEFAULTS.oauthRedirectUri,
    allowedScopeBits: '1',
  }), /official auto-submission scope/);
});

test('lookup URL allows HTTPS or loopback and rejects unsafe targets', () => {
  assert.equal(
    makePlayerLookupUrl('http://127.0.0.1:3100', 7410).href,
    'http://127.0.0.1:3100/v2/database/players/7410',
  );
  assert.throws(() => makePlayerLookupUrl('http://api.tuforums.com', 7410), /HTTPS/);
  assert.throws(() => makePlayerLookupUrl('https://api.tuforums.com/private', 7410), /origin only/);
});
