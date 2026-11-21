import { Worker, type WorkerOptions } from 'node:worker_threads';

const CANCELLED = 1;

let flag: Int32Array | null = null;
let watch: Worker | null = null;
let onWatchError: (error: Error) => void = () => undefined;

export function setBadgeWatchErrorHandler(handler: (error: Error) => void): void {
  onWatchError = handler;
}

export class BadgeJobCancelled extends Error {
  constructor() {
    super('Badge job cancelled');
    this.name = 'BadgeJobCancelled';
  }
}

export function throwIfBadgeCancelled(): void {
  if (flag && Atomics.load(flag, 0) === CANCELLED) throw new BadgeJobCancelled();
}

export function isBadgeCancelRequested(): boolean {
  return Boolean(flag && Atomics.load(flag, 0) === CANCELLED);
}

/** Test hook. Marks the in-process flag without opening a database watch. */
export function armBadgeCancel(): void {
  const shared = new SharedArrayBuffer(4);
  flag = new Int32Array(shared);
  Atomics.store(flag, 0, CANCELLED);
}

export function clearBadgeCancel(): void {
  flag = null;
}

export function watchBadgeJob(jobId: number): void {
  stopBadgeWatch();
  const shared = new SharedArrayBuffer(4);
  flag = new Int32Array(shared);
  Atomics.store(flag, 0, 0);
  const source = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  const options: WorkerOptions = {
    workerData: {
      flag: shared,
      jobId,
      host: process.env.DB_HOST || '127.0.0.1',
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER || '',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_DATABASE || '',
    },
  };
  if (source === 'ts') options.execArgv = ['--import', 'tsx'];
  watch = new Worker(new URL(`./cancelWatch.${source}`, import.meta.url), options);
  watch.unref();
  watch.on('error', (error) => {
    onWatchError(error instanceof Error ? error : new Error(String(error)));
  });
}

export function stopBadgeWatch(): void {
  const current = watch;
  watch = null;
  flag = null;
  if (!current) return;
  current.postMessage('stop');
  void current.terminate();
}
