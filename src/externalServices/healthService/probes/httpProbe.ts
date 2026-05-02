import axios, { AxiosError } from 'axios';
import type { ProbeResult } from './types.js';

/**
 * Generic HTTP probe used by every network-based component check.
 *
 * - Always uses an explicit per-call `timeout` so a hung remote can never
 *   exceed the agent's probe budget.
 * - Captures status code, latency and (on failure) Axios error code, so the
 *   health-service `details` field reflects exactly what went wrong.
 * - Never throws; failures are returned as `{ ok: false, ... }` so the agent
 *   can keep its overall-status calculation simple.
 */
export async function httpProbe(
  url: string,
  timeoutMs: number,
  opts?: { expectStatus?: (status: number) => boolean; captureBody?: boolean },
): Promise<ProbeResult> {
  const expectStatus = opts?.expectStatus ?? ((s: number) => s >= 200 && s < 300);
  const start = Date.now();
  try {
    const response = await axios.get(url, {
      timeout: timeoutMs,
      validateStatus: () => true,
    });
    const durationMs = Date.now() - start;
    const ok = expectStatus(response.status);
    const details: Record<string, unknown> = {
      url,
      status: response.status,
    };
    if (opts?.captureBody) {
      details.body = response.data;
    }
    return {
      ok,
      durationMs,
      message: ok
        ? `HTTP ${response.status}`
        : `HTTP ${response.status} (unexpected)`,
      details,
    };
  } catch (error) {
    const durationMs = Date.now() - start;
    const axiosErr = error as AxiosError;
    const code = axiosErr?.code;
    const msg = axiosErr?.message ?? (error instanceof Error ? error.message : String(error));
    return {
      ok: false,
      durationMs,
      message: code ? `${code}: ${msg}` : msg,
      details: {
        url,
        errorCode: code,
      },
    };
  }
}
