import { httpProbe } from './httpProbe.js';
import type { ProbeResult } from './types.js';

/**
 * Bilibili proxy liveness via cheap `GET /health`. An empty pool is still
 * healthy; this only checks that the process and Redis are up.
 */
export function makeBilibiliProxyProbe(
  url: string | undefined,
): (timeoutMs: number) => Promise<ProbeResult> {
  if (!url) {
    return async () => ({
      ok: true,
      durationMs: 0,
      message: 'bilibili-proxy probe disabled (HEALTH_BILIBILI_PROXY_URL unset)',
      skipped: true,
    });
  }
  return (timeoutMs: number) => httpProbe(url, timeoutMs);
}
