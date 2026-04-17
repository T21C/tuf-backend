import { logger } from '@/server/services/core/LoggerService.js';

export interface ShutdownStep {
  name: string;
  /** Steps run in ascending priority. 10..30 = workspaces / scratch, 50 = misc, 80..90 = DB / Redis. */
  priority: number;
  fn: () => Promise<void> | void;
}

const steps: ShutdownStep[] = [];
const globalAbortController = new AbortController();
let shuttingDown = false;
let shutdownPromise: Promise<void> | null = null;

const HARD_TIMEOUT_MS = 10_000;

/**
 * Returns the process-wide AbortSignal that fires once shutdown begins.
 * Pass this into long-running operations (axios, pipeline, exec) so they tear down cleanly.
 */
export function getGlobalAbortSignal(): AbortSignal {
  return globalAbortController.signal;
}

/**
 * Idempotent: same `name` replaces the previous registration.
 */
export function registerShutdownStep(step: ShutdownStep): void {
  const existingIdx = steps.findIndex(s => s.name === step.name);
  if (existingIdx >= 0) {
    steps[existingIdx] = step;
  } else {
    steps.push(step);
  }
}

export function unregisterShutdownStep(name: string): void {
  const idx = steps.findIndex(s => s.name === name);
  if (idx >= 0) steps.splice(idx, 1);
}

export function isShuttingDown(): boolean {
  return shuttingDown;
}

/**
 * Runs every registered step in ascending priority. Each step is wrapped in a try/catch so
 * one failure doesn't cancel the rest. If steps don't finish within {@link HARD_TIMEOUT_MS},
 * the process exits anyway.
 */
export function runShutdown(reason: string): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  if (!globalAbortController.signal.aborted) {
    globalAbortController.abort(new Error(`shutdown: ${reason}`));
  }

  shutdownPromise = (async () => {
    logger.info(`Shutdown initiated (${reason})`);
    const ordered = [...steps].sort((a, b) => a.priority - b.priority);
    const work = (async () => {
      for (const step of ordered) {
        try {
          logger.debug(`Shutdown step: ${step.name} (priority ${step.priority})`);
          await step.fn();
        } catch (error) {
          logger.error(`Shutdown step "${step.name}" failed:`, error);
        }
      }
    })();
    await Promise.race([
      work,
      new Promise<void>(resolve => setTimeout(() => {
        logger.warn(`Shutdown hard timeout after ${HARD_TIMEOUT_MS}ms; forcing exit`);
        resolve();
      }, HARD_TIMEOUT_MS)),
    ]);
    logger.info('Shutdown complete');
  })();

  return shutdownPromise;
}
