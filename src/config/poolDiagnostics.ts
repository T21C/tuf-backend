import { logger } from '../server/services/LoggerService.js';
import type { LogReplayEvent } from '../server/services/LoggerService.js';

// ——— Slow query logging (Sequelize `logging` + `benchmark: true`; timing excludes connection acquire wait) ———

const SLOW_QUERY_THRESHOLD_MS = process.env.SLOW_QUERY_THRESHOLD_MS
  ? parseInt(process.env.SLOW_QUERY_THRESHOLD_MS, 10)
  : 2000;

/** SQL fragments excluded from slow-query warnings (expected to be slow). */
export const POOL_SLOW_QUERY_EXCLUDED_PATTERNS = [
  'WITH PassesData AS', // PlayerStatsService bulk stats calculation
  'player_pass_summary', // Views involving pass summaries
] as const;

export function isExcludedSlowQuery(sql: string): boolean {
  return POOL_SLOW_QUERY_EXCLUDED_PATTERNS.some((pattern) => sql.includes(pattern));
}

/**
 * Sequelize `logging` callback: logs slow SQL with pool name.
 */
export function createSlowQueryLogging(poolName: string) {
  return (sql: string, timing?: number) => {
    if (timing && timing > SLOW_QUERY_THRESHOLD_MS && !isExcludedSlowQuery(sql)) {
      logger.warn(`Slow query (${timing}ms) [pool=${poolName}]`, {
        pool: poolName,
        durationMs: timing,
        sql: sql.substring(0, 500),
      });
    }
  };
}

// ——— Saturation monitoring (waiters queued for a connection) ———

let saturationTimer: ReturnType<typeof setInterval> | null = null;
const lastSaturationWarnAt = new Map<string, number>();
const consecutiveSaturationByPool = new Map<string, number>();

interface SaturationMonitorOptions {
  throttleMs: number;
  minWaitersToWarn: number;
  minPoolFillRatioToWarn: number;
  minConsecutiveChecksToWarn: number;
}

async function maybeLogPoolSaturation(
  getPoolStats: () => Promise<Record<string, any>>,
  options: SaturationMonitorOptions,
): Promise<void> {
  try {
    const stats = await getPoolStats();
    const now = Date.now();
    for (const [name, s] of Object.entries(stats)) {
      if (!s || typeof s !== 'object' || 'error' in s) {
        continue;
      }
      const waiting = typeof s.waiting === 'number' ? s.waiting : 0;
      const size = typeof s.size === 'number' ? s.size : 0;
      const max = typeof s.max === 'number' && s.max > 0 ? s.max : 0;
      const fillRatio = max > 0 ? size / max : 0;

      if (waiting <= 0) {
        consecutiveSaturationByPool.delete(name);
        continue;
      }

      const isAboveWaiterThreshold = waiting >= options.minWaitersToWarn;
      const isNearPoolCapacity = fillRatio >= options.minPoolFillRatioToWarn;
      if (!isAboveWaiterThreshold || !isNearPoolCapacity) {
        consecutiveSaturationByPool.delete(name);
        continue;
      }

      const consecutiveCount = (consecutiveSaturationByPool.get(name) ?? 0) + 1;
      consecutiveSaturationByPool.set(name, consecutiveCount);
      if (consecutiveCount < options.minConsecutiveChecksToWarn) {
        continue;
      }

      const last = lastSaturationWarnAt.get(name) ?? 0;
      if (now - last < options.throttleMs) {
        continue;
      }
      lastSaturationWarnAt.set(name, now);
      logger.warn(`Pool "${name}" has ${waiting} waiter(s) for a DB connection — possible starvation`, {
        pool: name,
        fillRatio: Number(fillRatio.toFixed(2)),
        consecutiveChecks: consecutiveCount,
        ...s,
      });
    }
  } catch (e) {
    logger.debug('Pool saturation check failed:', e);
  }
}

/**
 * Poll pool stats and warn when any pool has waiters. Disable: POOL_SATURATION_MONITOR=false.
 * Returns `stop` to clear the interval (call on pool shutdown).
 */
export function startPoolSaturationMonitoring(
  getPoolStats: () => Promise<Record<string, any>>,
): () => void {
  if (process.env.POOL_SATURATION_MONITOR === 'false') {
    return () => {};
  }
  const checkMs = Number(process.env.POOL_SATURATION_CHECK_MS || 3000);
  const options: SaturationMonitorOptions = {
    throttleMs: Number(process.env.POOL_SATURATION_LOG_THROTTLE_MS || 10000),
    minWaitersToWarn: Number(process.env.POOL_SATURATION_MIN_WAITERS || 2),
    minPoolFillRatioToWarn: Number(process.env.POOL_SATURATION_MIN_FILL_RATIO || 0.7),
    minConsecutiveChecksToWarn: Number(process.env.POOL_SATURATION_MIN_CONSECUTIVE_CHECKS || 2),
  };

  if (saturationTimer) {
    clearInterval(saturationTimer);
    saturationTimer = null;
  }

  const timer = setInterval(() => {
    void maybeLogPoolSaturation(getPoolStats, options);
  }, checkMs);
  timer.unref?.();
  saturationTimer = timer;

  return () => {
    if (saturationTimer === timer) {
      clearInterval(saturationTimer);
      saturationTimer = null;
    }
  };
}

// ——— Acquire-timeout snapshot (dynamic PoolManager import avoids circular deps with PoolManager) ———

/**
 * Log pool stats when Sequelize fails to acquire a connection within the pool timeout.
 * Safe to call from route handlers; no-op if `err` is not a connection acquire timeout.
 */
export function logPoolDiagnosticsOnAcquireTimeout(
  err: unknown,
  context?: Record<string, unknown>,
): void {
  const name =
    err && typeof err === 'object' && 'name' in err ? String((err as { name: string }).name) : '';
  if (name !== 'SequelizeConnectionAcquireTimeoutError') {
    return;
  }
  void import('./PoolManager.js').then(({ getPoolManager }) => {
    const pm = getPoolManager();
    void pm.getPoolStats().then((stats) => {
      logger.error('Sequelize connection acquire timeout — snapshot of all pools', {
        ...context,
        stats,
      });
    });
  });
}

/**
 * Scan logger replay `meta` for a Sequelize connection acquire timeout (e.g. `logger.error(msg, err)`).
 */
export function findSequelizeConnectionAcquireTimeoutErrorInMeta(meta: unknown[]): Error | null {
  const stack: unknown[] = [...meta];
  const seen = new Set<unknown>();

  while (stack.length) {
    const item = stack.pop();
    if (item === undefined || item === null || seen.has(item)) {
      continue;
    }
    seen.add(item);

    if (item instanceof Error && item.name === 'SequelizeConnectionAcquireTimeoutError') {
      return item;
    }
    if (typeof item === 'object') {
      const o = item as Record<string, unknown>;
      if (o.name === 'SequelizeConnectionAcquireTimeoutError') {
        return item as Error;
      }
      for (const k of ['error', 'err', 'cause', 'original', 'parent']) {
        const v = o[k];
        if (v !== undefined && v !== null) {
          stack.push(v);
        }
      }
    }
  }
  return null;
}

/**
 * Subscribe to logger replay: on matching errors, emit a pool snapshot. Disable: LOGGER_POOL_ACQUIRE_HOOK=false
 */
export function registerPoolAcquireLogReplayListener(): void {
  if (process.env.LOGGER_POOL_ACQUIRE_HOOK === 'false') {
    return;
  }
  logger.addLogReplayListener((event: LogReplayEvent) => {
    if (event.level !== 'error') {
      return;
    }
    const acquireErr = findSequelizeConnectionAcquireTimeoutErrorInMeta(event.meta);
    if (!acquireErr) {
      return;
    }
    logPoolDiagnosticsOnAcquireTimeout(acquireErr, {
      replayMessage: event.message,
      hook: 'poolDiagnostics.logReplay',
    });
  });
}

registerPoolAcquireLogReplayListener();
