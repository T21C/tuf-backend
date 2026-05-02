import { httpProbe } from './httpProbe.js';
import type { ProbeResult } from './types.js';

/**
 * CDN service liveness via the cheap `GET /health` endpoint mounted on the
 * CDN Express app. The route is intentionally trivial so a stuck DB or busy
 * upload pipeline can't block the probe.
 */
export function makeCdnProbe(baseUrl: string): (timeoutMs: number) => Promise<ProbeResult> {
  const url = `${baseUrl.replace(/\/$/, '')}/health`;
  return (timeoutMs: number) => httpProbe(url, timeoutMs);
}
