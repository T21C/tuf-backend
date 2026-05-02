import { httpProbe } from './httpProbe.js';
import type { ProbeResult } from './types.js';

/**
 * Optional nginx liveness probe. The dev machine has no nginx, so when
 * `HEALTH_NGINX_URL` is unset the probe returns `skipped: true` — the agent
 * excludes skipped probes from the legacy `checks` map and from the
 * overall-status calculation entirely.
 */
export function makeNginxProbe(url: string | undefined): (timeoutMs: number) => Promise<ProbeResult> {
  if (!url) {
    return async () => ({
      ok: true,
      durationMs: 0,
      message: 'nginx probe disabled (HEALTH_NGINX_URL unset)',
      skipped: true,
    });
  }
  return (timeoutMs: number) => httpProbe(url, timeoutMs);
}
