import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePushDeviceKey,
  parsePushDeviceProfile,
  planPushSubscriptionUpsert,
  type PushSubscriptionSnapshot,
} from './pushDevice.js';

const userId = 'user-1';
const otherUser = 'user-2';

function row(
  partial: Partial<PushSubscriptionSnapshot> & Pick<PushSubscriptionSnapshot, 'id' | 'endpoint'>,
): PushSubscriptionSnapshot {
  return {
    userId,
    deviceKey: null,
    revoked: false,
    ...partial,
  };
}

test('device keys are canonical uuids', () => {
  assert.equal(
    normalizePushDeviceKey(' 3F2504E0-4F89-41D3-9A0C-0305E82C3301 '),
    '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  );
  assert.equal(normalizePushDeviceKey('not-a-uuid'), null);
  assert.equal(normalizePushDeviceKey(12), null);
});

test('profiles distinguish browser and operating system', () => {
  assert.deepEqual(
    parsePushDeviceProfile(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0',
    ),
    {browser: 'Edge', os: 'Windows'},
  );
  assert.deepEqual(
    parsePushDeviceProfile(
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36',
    ),
    {browser: 'Chrome', os: 'Android'},
  );
  assert.deepEqual(parsePushDeviceProfile(''), {browser: 'Browser', os: ''});
});

test('attaching a new device does not replace the ones already saved', () => {
  const existing = [
    row({id: 1, endpoint: 'https://push.example/a', deviceKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}),
    row({id: 2, endpoint: 'https://push.example/b', deviceKey: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'}),
    row({id: 3, endpoint: 'https://push.example/c', deviceKey: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'}),
  ];
  const plan = planPushSubscriptionUpsert({
    intent: 'attach',
    userId,
    endpoint: 'https://push.example/d',
    deviceKey: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    rows: existing,
  });
  assert.deepEqual(plan, {action: 'create'});
});

test('the same device updates in place when its endpoint rotates', () => {
  const key = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const plan = planPushSubscriptionUpsert({
    intent: 'attach',
    userId,
    endpoint: 'https://push.example/new',
    deviceKey: key,
    rows: [
      row({id: 1, endpoint: 'https://push.example/old', deviceKey: key}),
      row({id: 2, endpoint: 'https://push.example/other', deviceKey: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'}),
      row({id: 9, endpoint: 'https://push.example/new', deviceKey: null}),
    ],
  });
  assert.deepEqual(plan, {action: 'update', id: 1, deleteIds: [9]});
});

test('refresh does not create a device and does not clear a removal', () => {
  assert.deepEqual(
    planPushSubscriptionUpsert({
      intent: 'refresh',
      userId,
      endpoint: 'https://push.example/new',
      deviceKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      rows: [],
    }),
    {action: 'missing'},
  );
  assert.deepEqual(
    planPushSubscriptionUpsert({
      intent: 'refresh',
      userId,
      endpoint: 'https://push.example/a',
      deviceKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      rows: [row({id: 4, endpoint: 'https://push.example/a', deviceKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', revoked: true})],
    }),
    {action: 'revoked'},
  );
});

test('an explicit attach reactivates a removed device without touching the others', () => {
  const key = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const plan = planPushSubscriptionUpsert({
    intent: 'attach',
    userId,
    endpoint: 'https://push.example/a',
    deviceKey: key,
    rows: [
      row({id: 4, endpoint: 'https://push.example/a', deviceKey: key, revoked: true}),
      row({id: 5, endpoint: 'https://push.example/phone', deviceKey: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'}),
    ],
  });
  assert.deepEqual(plan, {action: 'update', id: 4, deleteIds: []});
});

test('refresh does not take over another account subscription', () => {
  assert.deepEqual(
    planPushSubscriptionUpsert({
      intent: 'refresh',
      userId,
      endpoint: 'https://push.example/shared',
      deviceKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      rows: [row({id: 7, userId: otherUser, endpoint: 'https://push.example/shared'})],
    }),
    {action: 'missing'},
  );
});
