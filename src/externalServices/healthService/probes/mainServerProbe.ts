import { httpProbe } from './httpProbe.js';
import type { ProbeResult } from './types.js';

/**
 * Main API server liveness via `GET ${MAIN_URL}/v2/health`.
 *
 * The full body of the upstream response is preserved verbatim under
 * `details.mainServerInfo` so the legacy `/health/api` JSON can copy it back
 * out unchanged (the React HealthCheckPage still reads
 * `mainServerInfo.system.*` and `mainServerInfo.checks.socket.*`).
 */
export function makeMainServerProbe(baseUrl: string): (timeoutMs: number) => Promise<ProbeResult> {
  const url = baseUrl.replace(/\/$/, '');
  return async (timeoutMs: number) => {
    const result = await httpProbe(url, timeoutMs, { captureBody: true });

    const body = result.details?.body;
    return {
      ...result,
      details: {
        url,
        status: result.details?.status,
        errorCode: result.details?.errorCode,
        mainServerInfo: body ?? null,
      },
    };
  };
}
