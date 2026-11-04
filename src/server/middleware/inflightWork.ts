/**
 * In-process sharing for cache misses.
 *
 * One Node process can run the same fill many times when several requests miss
 * together. Callers with the same flight key share that fill. The registry drops
 * the entry when the fill finishes and never holds more than its max size.
 * Other processes keep their own registries; this does not lock Redis.
 */

export const INFLIGHT_CACHE_LIMIT = 1024;

const HTTP_FILL_TIMEOUT_MS = 60_000;

export type FlightClaim<T> =
  | { role: 'leader'; publish: (value: T) => void; fail: (error: unknown) => void }
  | { role: 'follower'; result: Promise<T> }
  | { role: 'overflow' };

type FlightSlot = {
  promise: Promise<unknown>;
};

export type InflightRegistry = {
  claim: <T>(key: string) => FlightClaim<T>;
  size: () => number;
};

export function createInflightRegistry(maxEntries = INFLIGHT_CACHE_LIMIT): InflightRegistry {
  const inflight = new Map<string, FlightSlot>();

  function claim<T>(key: string): FlightClaim<T> {
    const existing = inflight.get(key);
    if (existing) {
      return { role: 'follower', result: existing.promise as Promise<T> };
    }
    if (inflight.size >= maxEntries) return { role: 'overflow' };

    let publish!: (value: T) => void;
    let fail!: (error: unknown) => void;
    let settled = false;
    const promise = new Promise<T>((resolve, reject) => {
      const finish = (settle: () => void) => {
        if (settled) return;
        settled = true;
        if (inflight.get(key)?.promise === promise) inflight.delete(key);
        settle();
      };
      publish = (value) => finish(() => resolve(value));
      fail = (error) => finish(() => reject(error));
    });
    // A fill can fail before any follower attaches. Keep that rejection handled.
    void promise.catch(() => undefined);
    inflight.set(key, { promise });
    return { role: 'leader', publish, fail };
  }

  return {
    claim,
    size: () => inflight.size,
  };
}

export function layerFlightKey(storageKey: string, ttlSec: number, tags: readonly string[]): string {
  return JSON.stringify([ttlSec, storageKey, [...tags].sort()]);
}

type SharedLayer<T> = { shareable: true; value: T; hit: boolean } | { shareable: false };

/**
 * Plain JSON-like trees can be copied per caller. Class instances, dates, maps,
 * functions, and other exotic values cannot be handed out safely.
 */
export function copyIndependentValue<T>(value: T): { ok: true; value: T } | { ok: false } {
  if (!isPlainData(value)) return { ok: false };
  if (value === null || typeof value !== 'object') return { ok: true, value };
  try {
    return { ok: true, value: structuredClone(value) };
  } catch {
    return { ok: false };
  }
}

function isPlainData(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null) return true;
  if (typeof value !== 'object') {
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
  }
  if (seen.has(value)) return true;
  seen.add(value);
  if (Array.isArray(value)) return value.every((item) => isPlainData(item, seen));
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (!isPlainData((value as Record<string, unknown>)[key], seen)) return false;
  }
  return true;
}

function isPromise(value: unknown): value is Promise<unknown> {
  return !!value && typeof (value as Promise<unknown>).then === 'function';
}

function cloneSharedPlain<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  return structuredClone(value);
}

/**
 * Read-through fill. Concurrent callers of the same flight key share one
 * `produce` and one `write`. Each caller gets its own plain value. Exotic
 * values are produced again by each caller after the shared attempt finishes.
 */
export async function fillCacheOnce<T>(options: {
  registry: InflightRegistry;
  flightKey: string;
  read: () => Promise<T | null | undefined>;
  write: (value: T) => Promise<void>;
  produce: () => Promise<T>;
}): Promise<{ value: T; hit: boolean }> {
  const cached = await options.read();
  if (cached != null) return { value: cached, hit: true };

  const claim = options.registry.claim<SharedLayer<T>>(options.flightKey);
  if (claim.role === 'follower') return takeSharedLayer(claim.result, options);
  if (claim.role === 'overflow') return produceAndWrite(options);

  try {
    const again = await options.read();
    if (again != null) {
      publishLayer(claim.publish, again, true);
      return { value: again, hit: true };
    }
    const value = await options.produce();
    const snapshot = copyIndependentValue(value);
    await options.write(snapshot.ok ? snapshot.value : value);
    if (snapshot.ok) claim.publish({ shareable: true, value: snapshot.value, hit: false });
    else claim.publish({ shareable: false });
    return { value, hit: false };
  } catch (error) {
    claim.fail(error);
    throw error;
  }
}

function publishLayer<T>(publish: (value: SharedLayer<T>) => void, value: T, hit: boolean): void {
  const snapshot = copyIndependentValue(value);
  if (!snapshot.ok) {
    publish({ shareable: false });
    return;
  }
  publish({ shareable: true, value: snapshot.value, hit });
}

async function takeSharedLayer<T>(
  result: Promise<SharedLayer<T>>,
  options: {
    write: (value: T) => Promise<void>;
    produce: () => Promise<T>;
  },
): Promise<{ value: T; hit: boolean }> {
  const shared = await result;
  if (shared.shareable) {
    try {
      return { value: cloneSharedPlain(shared.value), hit: shared.hit };
    } catch {
      // Fall through and generate a private value.
    }
  }
  // Exotic values stay on the private path. Waiting for the shared attempt
  // keeps that work from running at the same time as the leader.
  return produceAndWrite(options);
}

async function produceAndWrite<T>(options: {
  write: (value: T) => Promise<void>;
  produce: () => Promise<T>;
}): Promise<{ value: T; hit: boolean }> {
  const value = await options.produce();
  const snapshot = copyIndependentValue(value);
  await options.write(snapshot.ok ? snapshot.value : value);
  return { value, hit: false };
}

export type CachedHttpBody = { statusCode: number; body: unknown };

type SharedHttpBody = CachedHttpBody & { plain: boolean };

export interface HttpCacheResponse {
  statusCode: number;
  setHeader(name: string, value: string | number): void;
  status(code: number): { json(body: unknown): unknown };
  json: (body: unknown) => unknown;
  once(event: 'finish' | 'close', listener: () => void): void;
}

/**
 * HTTP read-through. Followers wait until the leader has finished storing, not
 * until the socket `finish` event. That event fires when the bytes are sent,
 * which is earlier than the Redis write, and releasing there made every waiter
 * run the handler again.
 */
export async function coalesceHttpCache(options: {
  registry: InflightRegistry;
  cacheKey: string;
  ttlSec: number;
  addHeaders: boolean;
  res: HttpCacheResponse;
  read: () => Promise<CachedHttpBody | null>;
  readTtl: () => Promise<number>;
  write: (payload: CachedHttpBody) => Promise<unknown>;
  registerTags: () => Promise<void> | void;
  proceed: () => unknown;
  timeoutMs?: number;
  onTimeout?: () => void;
  onWriteError?: (error: unknown) => void;
  onTagError?: (error: unknown) => void;
}): Promise<unknown> {
  for (;;) {
    const cached = await options.read();
    if (cached) {
      return sendCached(options, cached, 'HIT', true);
    }

    const claim = options.registry.claim<SharedHttpBody | null>(options.cacheKey);
    if (claim.role === 'follower') {
      const shared = await claim.result;
      if (!shared) continue;
      return sendShared(options, shared);
    }
    if (claim.role === 'overflow') {
      const leader = hookLeader(options, null);
      try {
        return await runProceed(options.proceed);
      } catch (error) {
        leader.cancel();
        throw error;
      }
    }

    let again: CachedHttpBody | null;
    try {
      again = await options.read();
    } catch (error) {
      claim.fail(error);
      throw error;
    }
    if (again) {
      const copied = copyIndependentValue(again.body);
      claim.publish({
        statusCode: again.statusCode,
        body: copied.ok ? copied.value : again.body,
        plain: copied.ok,
      });
      return sendCached(options, again, 'HIT', true);
    }

    let jsonCalled = false;
    const leader = hookLeader(options, (value) => claim.publish(value), () => {
      jsonCalled = true;
    });
    try {
      return await runProceed(options.proceed);
    } catch (error) {
      if (!jsonCalled) leader.cancel();
      throw error;
    }
  }
}

async function sendCached(
  options: {
    res: HttpCacheResponse;
    addHeaders: boolean;
    readTtl: () => Promise<number>;
  },
  payload: CachedHttpBody,
  header: 'HIT' | 'MISS',
  includeTtl: boolean,
): Promise<unknown> {
  if (options.addHeaders) {
    options.res.setHeader('X-Cache', header);
    if (includeTtl) {
      const ttl = await options.readTtl();
      if (ttl > 0) options.res.setHeader('X-Cache-TTL', ttl);
    }
  }
  return options.res.status(payload.statusCode).json(payload.body);
}

function sendShared(
  options: { res: HttpCacheResponse; addHeaders: boolean; ttlSec: number },
  shared: SharedHttpBody,
): unknown {
  if (options.addHeaders) {
    options.res.setHeader('X-Cache', 'HIT');
    if (options.ttlSec > 0) options.res.setHeader('X-Cache-TTL', options.ttlSec);
  }
  const body = shared.plain ? cloneSharedPlain(shared.body) : shared.body;
  return options.res.status(shared.statusCode).json(body);
}

function hookLeader(
  options: {
    res: HttpCacheResponse;
    addHeaders: boolean;
    write: (payload: CachedHttpBody) => Promise<unknown>;
    registerTags: () => Promise<void> | void;
    timeoutMs?: number;
    onTimeout?: () => void;
    onWriteError?: (error: unknown) => void;
    onTagError?: (error: unknown) => void;
  },
  publish: ((value: SharedHttpBody | null) => void) | null,
  markJsonCalled?: () => void,
): { cancel: () => void } {
  const originalJson = options.res.json.bind(options.res);
  let released = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const finish = (value: SharedHttpBody | null) => {
    if (released) return;
    released = true;
    if (timeout) clearTimeout(timeout);
    publish?.(value);
  };
  timeout = setTimeout(() => {
    if (released) return;
    options.onTimeout?.();
    finish(null);
  }, options.timeoutMs ?? HTTP_FILL_TIMEOUT_MS);
  timeout.unref?.();

  let jsonCalled = false;
  const releaseIfSilent = () => {
    if (!jsonCalled) finish(null);
  };
  options.res.once('finish', releaseIfSilent);
  options.res.once('close', releaseIfSilent);

  options.res.json = function (body: unknown): unknown {
    jsonCalled = true;
    markJsonCalled?.();
    const statusCode = options.res.statusCode || 200;
    if (options.addHeaders) options.res.setHeader('X-Cache', 'MISS');

    if (statusCode >= 200 && statusCode < 300) {
      const copied = copyIndependentValue(body);
      const stored = copied.ok ? copied.value : body;
      // `finish` / `close` often run inside json(), before Redis accepts the write.
      // Keep followers waiting until that write settles.
      void Promise.resolve()
        .then(() => options.write({ statusCode, body: stored }))
        .then(() => {
          try {
            const pendingTags = options.registerTags();
            if (isPromise(pendingTags)) {
              void pendingTags.catch((error: unknown) => options.onTagError?.(error));
            }
          } catch (error) {
            options.onTagError?.(error);
          }
        })
        .catch((error: unknown) => {
          options.onWriteError?.(error);
        })
        .finally(() => {
          finish({ statusCode, body: stored, plain: copied.ok });
        });
    } else {
      const copied = copyIndependentValue(body);
      finish({
        statusCode,
        body: copied.ok ? copied.value : body,
        plain: copied.ok,
      });
    }

    return originalJson(body);
  };

  return { cancel: () => finish(null) };
}

async function runProceed(proceed: () => unknown): Promise<unknown> {
  const outcome = proceed();
  if (isPromise(outcome)) return outcome;
  return outcome;
}
