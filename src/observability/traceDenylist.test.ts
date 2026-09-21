import assert from 'node:assert/strict';
import test from 'node:test';
import { extractPathFromSamplingContext, isTraceDenylistedPath } from './traceDenylist.js';

test('denylists health, docs, and Vite static asset paths', () => {
  assert.equal(isTraceDenylistedPath('/health'), true);
  assert.equal(isTraceDenylistedPath('GET /v2/health'), true);
  assert.equal(isTraceDenylistedPath('/docs/index.html'), true);
  assert.equal(isTraceDenylistedPath('/assets/index.abc123.js'), true);
  assert.equal(isTraceDenylistedPath('GET /assets/style.def456.css?v=1'), true);
  assert.equal(isTraceDenylistedPath('/src/assets/important/dark/background-blurred.jpg'), true);
  assert.equal(isTraceDenylistedPath('/v2/levels/1'), false);
  assert.equal(isTraceDenylistedPath('GET https://tuforums.com/assets/app.abc.js'), true);
  assert.equal(isTraceDenylistedPath('GET https://api.tuforums.com/v2/auth/session'), false);
});

test('extractPathFromSamplingContext prefers http.route then pathname', () => {
  assert.equal(
    extractPathFromSamplingContext({
      name: 'GET /v2/health',
      attributes: { 'http.route': '/v2/auth/session' },
    }),
    '/v2/auth/session',
  );
  assert.equal(
    extractPathFromSamplingContext({
      normalizedRequest: { url: 'https://api.tuforums.com/assets/app.js' },
    }),
    '/assets/app.js',
  );
});
