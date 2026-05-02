/**
 * Shared probe contract used by every component check in the health service.
 *
 * Each probe runs to completion (success or failure) and returns a
 * {@link ProbeResult}. Errors should be caught inside the probe and reflected
 * via `ok: false` + `message` rather than thrown — the agent uses
 * `Promise.allSettled` but probes returning rejections degrade the overall
 * status logic, so consistent shapes matter.
 */
export interface ProbeResult {
  /** Whether the component is reachable and responsive. */
  ok: boolean;
  /** Wall-clock duration of the probe in milliseconds. */
  durationMs: number;
  /** Short human-readable reason (success or failure). */
  message: string;
  /** Probe-specific structured details (status code, pool stats, raw body, etc.). */
  details?: Record<string, unknown>;
  /**
   * If true, this probe is informational only and must not contribute to the
   * overall `online | degraded | offline` status. Used by `nginx` when
   * `HEALTH_NGINX_URL` is unset.
   */
  skipped?: boolean;
}

/** Probe identifier used as map key in the agent and in log metadata. */
export type ProbeName = 'database' | 'mainServer' | 'cdn' | 'cdc' | 'nginx';

/** Function signature every probe module exports as `runProbe`. */
export type ProbeFn = (timeoutMs: number) => Promise<ProbeResult>;
