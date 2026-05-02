import { httpProbe } from './httpProbe.js';
import type { ProbeResult } from './types.js';

/**
 * CDC service liveness via `GET http://localhost:${CDC_HEALTH_PORT}/health`.
 * The route already exists in `cdcService/app.ts` and returns
 * `{ ok: true, service: 'cdc' }` synchronously.
 */
export function makeCdcProbe(baseUrl: string): (timeoutMs: number) => Promise<ProbeResult> {
  const url = `${baseUrl.replace(/\/$/, '')}/health`;
  return (timeoutMs: number) => httpProbe(url, timeoutMs);
}
