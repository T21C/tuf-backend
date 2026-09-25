import assert from 'node:assert/strict';
import test from 'node:test';
import { ownsReplayPass, requestPassVisuals, visualDefaultsSchema } from './passVisuals.js';

const ownerId = '00000000-0000-4000-8000-000000000001';
const runId = '00000000-0000-4000-8000-000000000002';
const presetId = '00000000-0000-4000-8000-000000000003';
const defaults = { keyviewer_id: presetId, overlay_id: null };
const response = { defaults, presets: [{ id: presetId, name: 'My keys', kind: 'keyviewer', source: 'dmnote', is_hidden: false }] };
const env = { AUTO_SUBMISSION_API_URL: 'https://replay.example', AUTO_SUBMISSION_TO_TUF_TOKEN: 'a'.repeat(48), TUF_TO_AUTO_SUBMISSION_TOKEN: 'b'.repeat(48) };

test('only the current pass owner can edit published replay visuals', () => {
  const user = { id: ownerId, playerId: 5 };
  const pass = { playerId: 5, autoSubmissionRunId: runId, isDeleted: null };
  assert.equal(ownsReplayPass(user, pass), true);
  for (const candidate of [{ ...pass, playerId: 6 }, { ...pass, isDeleted: true }, { ...pass, autoSubmissionRunId: null }])
    assert.equal(ownsReplayPass(user, candidate), false);
  assert.equal(ownsReplayPass(undefined, pass), false);
  assert.equal(ownsReplayPass({ id: ownerId }, pass), false);
  assert.equal(visualDefaultsSchema.safeParse({ ...defaults, owner_id: ownerId }).success, false);
  assert.equal(visualDefaultsSchema.safeParse({ keyviewer_id: null }).success, false);
});

test('read, defaults and visibility use authenticated fixed internal routes', async () => {
  for (const operation of ['read', 'defaults', 'visibility'] as const) {
    const fetcher = (async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin, env.AUTO_SUBMISSION_API_URL);
      assert.equal(url.pathname, `/internal/tuf/replays/${runId}/visuals${operation === 'visibility' ? `/${presetId}/visibility` : ''}`);
      assert.equal(init?.redirect, 'error');
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${env.TUF_TO_AUTO_SUBMISSION_TOKEN}`);
      assert.equal(init?.method, operation === 'read' ? 'GET' : 'PUT');
      if (operation === 'read') {
        assert.equal(url.searchParams.get('owner_id'), ownerId);
        assert.equal(url.searchParams.get('pass_id'), '3132');
      } else assert.deepEqual(JSON.parse(String(init?.body)), {
        owner_id: ownerId, pass_id: 3132, ...(operation === 'defaults' ? { defaults } : { hidden: true }),
      });
      return Response.json(response);
    }) as typeof fetch;
    assert.deepEqual(await requestPassVisuals({ runId, ownerId, passId: 3132, operation, defaults, presetId, hidden: true }, fetcher, env), response);
  }
});

test('upstream failures and malformed replies cannot masquerade as saved settings', async () => {
  const input = { runId, ownerId, passId: 3132, operation: 'read' as const };
  for (const status of [400, 404, 401, 500]) {
    await assert.rejects(requestPassVisuals(input, (async () => new Response('private internal detail', { status })) as typeof fetch, env),
      (error: {code?: number; error?: string}) => error.code === (status === 400 || status === 404 ? status : 503) && !error.error?.includes('private'));
  }
  await assert.rejects(requestPassVisuals(input, (async () => Response.json({ presets: [] })) as typeof fetch, env));
});
