import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acquireSubmissionWorkerLock,
  releaseSubmissionWorkerLock,
} from './submissionWorkerLock.js';

function createMemoryRedis() {
  const store = new Map<string, string>();
  return {
    store,
    async set(key: string, value: string, options?: { NX?: boolean; EX?: number }) {
      if (options?.NX && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    },
    async eval(
      _script: string,
      args: { keys: string[]; arguments: string[] },
    ) {
      const key = args.keys[0];
      const token = args.arguments[0];
      if (!key) return 0;
      if (store.get(key) !== token) return 0;
      store.delete(key);
      return 1;
    },
  };
}

test('worker lock is exclusive for one item at a time', async () => {
  const client = createMemoryRedis();
  assert.equal(await acquireSubmissionWorkerLock(client, 'worker-a'), true);
  assert.equal(await acquireSubmissionWorkerLock(client, 'worker-b'), false);
  await releaseSubmissionWorkerLock(client, 'worker-a');
  assert.equal(await acquireSubmissionWorkerLock(client, 'worker-b'), true);
});

test('lock release is a no-op for a mismatched token', async () => {
  const client = createMemoryRedis();
  assert.equal(await acquireSubmissionWorkerLock(client, 'owner'), true);
  await releaseSubmissionWorkerLock(client, 'intruder');
  assert.equal(await acquireSubmissionWorkerLock(client, 'other'), false);
  await releaseSubmissionWorkerLock(client, 'owner');
  assert.equal(await acquireSubmissionWorkerLock(client, 'other'), true);
});
