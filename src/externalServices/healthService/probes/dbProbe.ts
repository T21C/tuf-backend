import { QueryTypes } from 'sequelize';
import { getPoolManager } from '@/config/PoolManager.js';
import type { ProbeResult } from './types.js';

/**
 * DB liveness via `SELECT 1` against the default pool.
 *
 * Mirrors the legacy behavior in `HealthService.checkDatabase` (5s race-based
 * timeout, swallowing `closed state` noise during shutdown) but returns the
 * shared {@link ProbeResult} shape so the agent can treat it uniformly.
 */
export async function runProbe(timeoutMs: number): Promise<ProbeResult> {
  const start = Date.now();

  let sequelize;
  try {
    sequelize = getPoolManager().getDefaultPool();
  } catch (error) {
    return {
      ok: false,
      durationMs: Date.now() - start,
      message: 'Default pool unavailable',
      details: {
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Database check timeout')), timeoutMs),
  );

  try {
    await Promise.race([
      sequelize.query<{ result: number }>('SELECT 1 AS result', {
        type: QueryTypes.SELECT,
        raw: true,
      }),
      timeout,
    ]);
    return {
      ok: true,
      durationMs: Date.now() - start,
      message: 'SELECT 1 ok',
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const isClosedState =
      msg.includes('closed state') ||
      (error as { parent?: { message?: string } })?.parent?.message?.includes('closed state');
    return {
      ok: false,
      durationMs: Date.now() - start,
      message: isClosedState ? 'pool in closed state' : msg,
      details: {
        suppressedFromLogs: isClosedState,
      },
    };
  }
}
