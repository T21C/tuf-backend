import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseAnnouncementWebhookTargets,
  requireAnnouncementWebhookTargets,
} from './parseAnnouncementWebhookTargets.js';

const HOOK_A = 'https://discord.com/api/webhooks/1/aaa';
const HOOK_B = 'https://discord.com/api/webhooks/2/bbb';
const HOOK_C = 'https://discord.com/api/webhooks/3/ccc';

test('pairs comma-separated hooks and roles by position', () => {
  const parsed = parseAnnouncementWebhookTargets(
    ` ${HOOK_A}, ${HOOK_B} `,
    ' 111 , 222 ',
  );
  assert.equal(parsed.mismatch, null);
  assert.deepEqual(parsed.targets, [
    {webhookUrl: HOOK_A, ping: '<@&111>'},
    {webhookUrl: HOOK_B, ping: '<@&222>'},
  ]);
});

test('keeps a blank role slot as no ping', () => {
  const parsed = parseAnnouncementWebhookTargets(
    `${HOOK_A},${HOOK_B},${HOOK_C}`,
    '111,,333',
  );
  assert.equal(parsed.mismatch, null);
  assert.deepEqual(parsed.targets, [
    {webhookUrl: HOOK_A, ping: '<@&111>'},
    {webhookUrl: HOOK_B, ping: undefined},
    {webhookUrl: HOOK_C, ping: '<@&333>'},
  ]);
});

test('pads missing roles and reports the original counts', () => {
  const parsed = parseAnnouncementWebhookTargets(`${HOOK_A},${HOOK_B}`, '111');
  assert.deepEqual(parsed.mismatch, {webhookCount: 2, roleIdCount: 1});
  assert.deepEqual(parsed.targets, [
    {webhookUrl: HOOK_A, ping: '<@&111>'},
    {webhookUrl: HOOK_B, ping: undefined},
  ]);
});

test('drops extra roles', () => {
  const parsed = parseAnnouncementWebhookTargets(HOOK_A, '111,222');
  assert.deepEqual(parsed.mismatch, {webhookCount: 1, roleIdCount: 2});
  assert.deepEqual(parsed.targets, [{webhookUrl: HOOK_A, ping: '<@&111>'}]);
});

test('removes blank webhook entries before pairing roles', () => {
  const parsed = parseAnnouncementWebhookTargets(`${HOOK_A},,${HOOK_B}`, '111,222');
  assert.equal(parsed.mismatch, null);
  assert.deepEqual(parsed.targets, [
    {webhookUrl: HOOK_A, ping: '<@&111>'},
    {webhookUrl: HOOK_B, ping: '<@&222>'},
  ]);
});

test('treats an unset role list as one empty slot', () => {
  const one = parseAnnouncementWebhookTargets(HOOK_A, '');
  assert.equal(one.mismatch, null);
  assert.deepEqual(one.targets, [{webhookUrl: HOOK_A, ping: undefined}]);

  const two = parseAnnouncementWebhookTargets(`${HOOK_A},${HOOK_B}`, '');
  assert.deepEqual(two.mismatch, {webhookCount: 2, roleIdCount: 1});
  assert.equal(two.targets[0].ping, undefined);
  assert.equal(two.targets[1].ping, undefined);
});

test('returns no targets when every hook is blank', () => {
  assert.deepEqual(parseAnnouncementWebhookTargets('  ,  ', '111'), {
    targets: [],
    mismatch: null,
  });
});

test('requireAnnouncementWebhookTargets throws when unconfigured and forwards mismatches', () => {
  assert.throws(
    () => requireAnnouncementWebhookTargets('', '', 'CURATION_ANNOUNCEMENT_HOOK is not configured'),
    /CURATION_ANNOUNCEMENT_HOOK is not configured/,
  );

  const seen: unknown[] = [];
  const targets = requireAnnouncementWebhookTargets(
    `${HOOK_A},${HOOK_B}`,
    '111',
    'unused',
    (info) => seen.push(info),
  );
  assert.deepEqual(seen, [{webhookCount: 2, roleIdCount: 1}]);
  assert.equal(targets.length, 2);
  assert.equal(targets[1].ping, undefined);
});
