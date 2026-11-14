import assert from 'node:assert/strict';
import test from 'node:test';
import {billingCallbackRedirectTarget} from './billingCallbackRedirect.js';

const allowed = new Set([
  'https://tuforums.com',
  'https://www.tuforums.com',
  'https://staging.tuforums.com',
  'https://tufstaging.online',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]);

function target(raw: unknown): string | null {
  return billingCallbackRedirectTarget(raw, (origin) => allowed.has(origin));
}

void test('billing callback allows trusted site origins only', () => {
  assert.equal(
    target('https://tuforums.com/settings/billing?ok=1'),
    'https://tuforums.com/settings/billing?ok=1',
  );
  assert.equal(target('https://staging.tuforums.com/callback'), 'https://staging.tuforums.com/callback');
  assert.equal(target('http://localhost:5173/callback'), 'http://localhost:5173/callback');
  assert.equal(target('  https://www.tuforums.com/mods  '), 'https://www.tuforums.com/mods');
});

void test('billing callback rejects off-site and non-http destinations', () => {
  for (const raw of [
    'https://evil.example/phish',
    'https://tuforums.com.evil.example/',
    'http://tuforums.com/',
    'javascript:alert(1)',
    '//evil.example',
    'https://user:pass@tuforums.com/',
    'https://tuforums.com\\@evil.example/',
    '',
    null,
  ]) {
    assert.equal(target(raw), null, String(raw));
  }
});
