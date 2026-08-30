import assert from 'node:assert/strict';
import test from 'node:test';

import {parseModReportBody, REPORT_NOTE_MAX} from './modReportParse.js';
import {VERSION_MAX} from './modFields.js';

void test('parseModReportBody requires a known reason', () => {
  assert.equal(parseModReportBody(null).ok, false);
  assert.equal(parseModReportBody({}).ok, false);
  assert.equal(parseModReportBody({reason: 'spam'}).ok, false);
});

void test('parseModReportBody accepts deprecated with version and brokenEffect', () => {
  const parsed = parseModReportBody({
    reason: 'deprecated',
    version: '  v2.9.8  ',
    brokenEffect: '  Crashes on load  ',
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.value, {
    reason: 'deprecated',
    version: 'v2.9.8',
    brokenEffect: 'Crashes on load',
  });
});

void test('parseModReportBody rejects deprecated without fields or oversized version', () => {
  assert.equal(parseModReportBody({reason: 'deprecated', version: 'v1'}).ok, false);
  assert.equal(
    parseModReportBody({reason: 'deprecated', version: 'v1', brokenEffect: ''}).ok,
    false,
  );
  assert.equal(
    parseModReportBody({
      reason: 'deprecated',
      version: 'x'.repeat(VERSION_MAX + 1),
      brokenEffect: 'breaks',
    }).ok,
    false,
  );
});

void test('parseModReportBody accepts abuse note', () => {
  const parsed = parseModReportBody({reason: 'abuse', note: '  malware  '});
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.value, {reason: 'abuse', note: 'malware'});
  assert.equal(parseModReportBody({reason: 'abuse', note: ''}).ok, false);
  assert.equal(
    parseModReportBody({reason: 'abuse', note: 'n'.repeat(REPORT_NOTE_MAX + 1)}).ok,
    false,
  );
});

void test('parseModReportBody accepts duplicate targetUrl and mergeWhy', () => {
  const parsed = parseModReportBody({
    reason: 'duplicate',
    targetUrl: 'https://tuforums.com/mods/litematica',
    mergeWhy: '  Same files  ',
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.reason, 'duplicate');
  if (parsed.value.reason !== 'duplicate') return;
  assert.equal(parsed.value.targetUrl, 'https://tuforums.com/mods/litematica');
  assert.equal(parsed.value.mergeWhy, 'Same files');

  assert.equal(
    parseModReportBody({
      reason: 'duplicate',
      targetUrl: 'javascript:alert(1)',
      mergeWhy: 'nope',
    }).ok,
    false,
  );
  assert.equal(
    parseModReportBody({
      reason: 'duplicate',
      targetUrl: 'https://tuforums.com/mods/a',
      mergeWhy: '',
    }).ok,
    false,
  );
});
