import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hashDownloadIp,
  pruneUniquesBeforeDate,
  utcDayDate,
} from './modDownloadCount.js';

void test('download unique helpers are date math only and hash ips', () => {
  const now = new Date('2026-08-29T15:04:00.000Z');
  assert.equal(utcDayDate(now), '2026-08-29');
  assert.equal(pruneUniquesBeforeDate(now), '2026-08-22');
  const hash = hashDownloadIp('203.0.113.50');
  assert.equal(hash.length, 64);
  assert.equal(hashDownloadIp('203.0.113.50'), hash);
  assert.notEqual(hashDownloadIp('203.0.113.51'), hash);
  assert.equal(hash.includes('process.env'), false);
});
