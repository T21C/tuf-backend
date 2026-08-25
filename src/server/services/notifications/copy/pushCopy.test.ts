import {test} from 'node:test';
import assert from 'node:assert/strict';
import {interpolateTemplate, renderPushCopy} from './pushCopy.js';

test('copy interpolates title and body without reason', () => {
  const {title, body} = renderPushCopy('en', 'pass.submission.approved', {
    song: 'Storm',
    artist: 'Camellia',
    reason: 'should not appear',
    levelId: 12,
  });
  assert.equal(title, 'Pass approved');
  assert.match(body, /Storm/);
  assert.match(body, /Camellia/);
  assert.equal(body.includes('should not appear'), false);
  assert.equal(body.toLowerCase().includes('reason'), false);
});

test('interpolateTemplate skips nullish values', () => {
  assert.equal(interpolateTemplate('Hello {{name}}', {name: 'TUF'}), 'Hello TUF');
  assert.equal(interpolateTemplate('Hello {{name}}', {name: undefined}), 'Hello ');
});
