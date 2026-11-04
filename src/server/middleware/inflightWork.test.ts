import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CachedHttpBody,
  coalesceHttpCache,
  copyIndependentValue,
  createInflightRegistry,
  fillCacheOnce,
  HttpCacheResponse,
  layerFlightKey,
} from './inflightWork.js';

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type Listener = () => void;

function fakeRes(): HttpCacheResponse & {
  headers: Record<string, string | number>;
  body: unknown;
} {
  const listeners: Record<'finish' | 'close', Listener[]> = { finish: [], close: [] };
  const res = {
    statusCode: 200,
    headers: {} as Record<string, string | number>,
    body: undefined as unknown,
    setHeader(name: string, value: string | number) {
      this.headers[name] = value;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      // Socket close/finish runs as part of sending, before a Redis write resolves.
      for (const event of ['finish', 'close'] as const) {
        const pending = listeners[event].splice(0);
        for (const listener of pending) listener();
      }
      return this;
    },
    once(event: 'finish' | 'close', listener: Listener) {
      listeners[event].push(listener);
    },
  };
  return res;
}

test('layer flight key ignores tag order and keeps ttl distinct', () => {
  assert.equal(layerFlightKey('pack:1', 30, ['b', 'a']), layerFlightKey('pack:1', 30, ['a', 'b']));
  assert.notEqual(layerFlightKey('pack:1', 30, ['a']), layerFlightKey('pack:1', 15, ['a']));
  assert.notEqual(layerFlightKey('pack:1', 30, ['a']), layerFlightKey('pack:1', 30, ['a', 'b']));
});

test('concurrent layer misses share one produce and keep independent objects', async () => {
  const registry = createInflightRegistry();
  const memory: { current: { items: number[] } | null } = { current: null };
  let produces = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const fill = () => fillCacheOnce({
    registry,
    flightKey: 'same',
    read: async () => {
      await Promise.resolve();
      return memory.current;
    },
    write: async (value) => {
      memory.current = value;
    },
    produce: async () => {
      produces += 1;
      await gate;
      return { items: [0] };
    },
  });

  const pending = Promise.all([fill(), fill(), fill()]);
  await flush();
  assert.equal(produces, 1);
  assert.equal(registry.size(), 1);
  release();
  const results = await pending;

  assert.equal(produces, 1);
  assert.equal(registry.size(), 0);
  assert.equal(results.every((result) => result.hit === false), true);
  results[0].value.items.push(1);
  results[1].value.items.push(2);
  assert.deepEqual(results[2].value.items, [0]);
  assert.deepEqual(memory.current?.items, [0]);
});

test('a failed fill is shared, cleared, and the next call can retry', async () => {
  const registry = createInflightRegistry();
  let produces = 0;

  const fill = () => fillCacheOnce({
    registry,
    flightKey: 'retry',
    read: async () => {
      await Promise.resolve();
      return null;
    },
    write: async () => undefined,
    produce: async () => {
      produces += 1;
      if (produces === 1) throw new Error('boom');
      return { ok: true };
    },
  });

  const firstWave = await Promise.allSettled([fill(), fill()]);
  assert.equal(produces, 1);
  assert.equal(registry.size(), 0);
  assert.equal(firstWave.every((item) => item.status === 'rejected'), true);

  const retried = await fill();
  assert.equal(produces, 2);
  assert.deepEqual(retried.value, { ok: true });
});

test('exotic objects wait for the leader and then generate a private value', async () => {
  const registry = createInflightRegistry();
  class Token {
    constructor(readonly id: number) {}
    label(): number {
      return this.id;
    }
  }

  let produces = 0;
  const startedAfterLeader: boolean[] = [];
  let leaderFinished = false;

  const fill = () => fillCacheOnce<Token>({
    registry,
    flightKey: 'token',
    read: async () => null,
    write: async () => undefined,
    produce: async () => {
      produces += 1;
      startedAfterLeader.push(leaderFinished);
      await Promise.resolve();
      leaderFinished = true;
      return new Token(produces);
    },
  });

  const [first, second] = await Promise.all([fill(), fill()]);
  assert.deepEqual(startedAfterLeader, [false, true]);
  assert.equal(produces, 2);
  assert.equal(first.value.label(), 1);
  assert.equal(second.value.label(), 2);
  assert.equal(copyIndependentValue(first.value).ok, false);
});

test('a full registry still shares an existing key and skips tracking a new one', async () => {
  const registry = createInflightRegistry(1);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const produces: string[] = [];

  const fill = (flightKey: string) => fillCacheOnce({
    registry,
    flightKey,
    read: async () => {
      await Promise.resolve();
      return null;
    },
    write: async () => undefined,
    produce: async () => {
      produces.push(flightKey);
      if (flightKey === 'held') await gate;
      return { flightKey };
    },
  });

  const held = Promise.all([fill('held'), fill('held')]);
  const overflow = fill('other');
  await flush();
  assert.equal(produces.filter((key) => key === 'held').length, 1);
  assert.equal(produces.filter((key) => key === 'other').length, 1);
  assert.equal(registry.size(), 1);
  release();
  const [shared, extra] = await Promise.all([held, overflow]);
  assert.equal(shared[0].value.flightKey, 'held');
  assert.equal(shared[1].value.flightKey, 'held');
  assert.equal(extra.value.flightKey, 'other');
  assert.equal(registry.size(), 0);
});

test('cached values skip produce, including false', async () => {
  const registry = createInflightRegistry();
  let produces = 0;
  const hit = await fillCacheOnce({
    registry,
    flightKey: 'hit',
    read: async () => ({ n: 1 }),
    write: async () => undefined,
    produce: async () => {
      produces += 1;
      return { n: 2 };
    },
  });
  const falseHit = await fillCacheOnce<boolean>({
    registry,
    flightKey: 'false',
    read: async () => false,
    write: async () => undefined,
    produce: async () => {
      produces += 1;
      return true;
    },
  });
  assert.deepEqual(hit, { value: { n: 1 }, hit: true });
  assert.deepEqual(falseHit, { value: false, hit: true });
  assert.equal(produces, 0);
  assert.equal(registry.size(), 0);
});

test('http misses share one handler even when the response finishes before the write', async () => {
  const registry = createInflightRegistry();
  const store = new Map<string, CachedHttpBody>();
  let produces = 0;
  let writes = 0;
  let tags = 0;
  let releaseWrite!: () => void;
  const writeGate = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  const res1 = fakeRes();
  const res2 = fakeRes();

  const run = (res: ReturnType<typeof fakeRes>) => coalesceHttpCache({
    registry,
    cacheKey: 'route',
    ttlSec: 30,
    addHeaders: true,
    res,
    read: async () => {
      await Promise.resolve();
      return store.get('route') ?? null;
    },
    readTtl: async () => 30,
    write: async (payload) => {
      writes += 1;
      await writeGate;
      store.set('route', payload);
    },
    registerTags: () => {
      tags += 1;
    },
    proceed: () => {
      produces += 1;
      const payload = { items: [1] };
      res.status(200).json(payload);
      payload.items.push(9);
    },
  });

  const leader = run(res1);
  const follower = run(res2);
  await leader;
  await flush();
  assert.equal(produces, 1);
  assert.equal(writes, 1);
  assert.equal(res2.body, undefined);
  assert.equal(res1.headers['X-Cache'], 'MISS');
  releaseWrite();
  await follower;

  assert.equal(produces, 1);
  assert.equal(writes, 1);
  assert.equal(tags, 1);
  assert.equal(registry.size(), 0);
  assert.deepEqual(res2.body, { items: [1] });
  assert.equal(res2.headers['X-Cache'], 'HIT');
  assert.equal(res2.headers['X-Cache-TTL'], 30);
  assert.deepEqual(res1.body, { items: [1, 9] });
  assert.deepEqual(store.get('route')?.body, { items: [1] });

  const res3 = fakeRes();
  await run(res3);
  assert.equal(produces, 1);
  assert.equal(res3.headers['X-Cache'], 'HIT');
  assert.deepEqual(res3.body, { items: [1] });
});

test('http error responses are shared and not stored', async () => {
  const registry = createInflightRegistry();
  let produces = 0;
  let writes = 0;
  const res1 = fakeRes();
  const res2 = fakeRes();

  const run = (res: ReturnType<typeof fakeRes>) => coalesceHttpCache({
    registry,
    cacheKey: 'missing',
    ttlSec: 15,
    addHeaders: true,
    res,
    read: async () => {
      await Promise.resolve();
      return null;
    },
    readTtl: async () => 15,
    write: async () => {
      writes += 1;
    },
    registerTags: () => undefined,
    proceed: () => {
      produces += 1;
      res.status(404).json({ reason: 'missing' });
    },
  });

  await Promise.all([run(res1), run(res2)]);
  assert.equal(produces, 1);
  assert.equal(writes, 0);
  assert.equal(res1.statusCode, 404);
  assert.equal(res2.statusCode, 404);
  assert.deepEqual(res2.body, { reason: 'missing' });
  const leaderBody = res1.body as { reason: string };
  leaderBody.reason = 'changed';
  assert.equal((res2.body as { reason: string }).reason, 'missing');
});

test('a leader that fails before sending lets one follower generate the response', async () => {
  const registry = createInflightRegistry();
  let produces = 0;
  const res1 = fakeRes();
  const res2 = fakeRes();

  const run = (res: ReturnType<typeof fakeRes>) => coalesceHttpCache({
    registry,
    cacheKey: 'flaky',
    ttlSec: 10,
    addHeaders: false,
    res,
    read: async () => {
      await Promise.resolve();
      return null;
    },
    readTtl: async () => 0,
    write: async () => undefined,
    registerTags: () => undefined,
    proceed: () => {
      produces += 1;
      if (produces === 1) throw new Error('handler failed');
      res.status(200).json({ ok: true });
    },
  });

  const settled = await Promise.allSettled([run(res1), run(res2)]);
  assert.equal(settled[0].status, 'rejected');
  assert.equal(settled[1].status, 'fulfilled');
  assert.equal(produces, 2);
  assert.deepEqual(res2.body, { ok: true });
  await flush();
  assert.equal(registry.size(), 0);
});

test('a timed out fill releases the waiter to run its own handler', async () => {
  const registry = createInflightRegistry();
  let produces = 0;
  let timeouts = 0;

  const run = (res: ReturnType<typeof fakeRes>) => coalesceHttpCache({
    registry,
    cacheKey: 'slow',
    ttlSec: 10,
    addHeaders: false,
    res,
    timeoutMs: 30,
    read: async () => null,
    readTtl: async () => 0,
    write: async () => undefined,
    registerTags: () => undefined,
    onTimeout: () => {
      timeouts += 1;
    },
    proceed: () => {
      produces += 1;
    },
  });

  // The fill timer is unref'd so a stuck request cannot hold the process open.
  // A referenced timer has to stay active or the test runner treats the loop as
  // idle and cancels this test before that timer can release the waiter.
  const keepAlive = setInterval(() => undefined, 20);
  try {
    const first = run(fakeRes());
    const second = run(fakeRes());
    await first;
    assert.equal(produces, 1);
    await second;
    assert.equal(produces, 2);
    await delay(50);
    assert.equal(timeouts, 2);
    assert.equal(registry.size(), 0);
  } finally {
    clearInterval(keepAlive);
  }
});
