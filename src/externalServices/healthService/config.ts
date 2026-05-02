import dotenv from 'dotenv';

dotenv.config();

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envString(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw && raw.length > 0 ? raw : fallback;
}

/**
 * Resolve the main API URL, mirroring the legacy port mapping
 * (3000 in production, 3002 otherwise) but allowing an explicit override.
 */
function defaultMainServerUrl(): string {
  if (process.env.HEALTH_MAIN_SERVER_URL) return process.env.HEALTH_MAIN_SERVER_URL;
  const port = process.env.NODE_ENV === 'production' ? 3000 : 3002;
  return `http://localhost:${port}`;
}

/** Resolve the CDN URL, preferring `HEALTH_CDN_URL` over the shared `LOCAL_CDN_URL`. */
function defaultCdnUrl(): string {
  return (
    process.env.HEALTH_CDN_URL ||
    process.env.LOCAL_CDN_URL ||
    'http://localhost:3001'
  );
}

/** Resolve the CDC URL using the same `CDC_HEALTH_PORT` env the CDC service binds to. */
function defaultCdcUrl(): string {
  if (process.env.HEALTH_CDC_URL) return process.env.HEALTH_CDC_URL;
  const port = envInt('CDC_HEALTH_PORT', 3990);
  return `http://localhost:${port}`;
}

/** Centralized, env-driven config for the standalone health service. */
export const HEALTH_CONFIG = {
  port: envInt('HEALTH_PORT', 3883),
  probeIntervalMs: envInt('HEALTH_PROBE_INTERVAL_MS', 5000),
  probeTimeoutMs: envInt('HEALTH_PROBE_TIMEOUT_MS', 5000),
  /** Probes slower than this emit a `warn` even if the result is `ok`. */
  slowProbeThresholdMs: envInt('HEALTH_SLOW_PROBE_THRESHOLD_MS', 2000),
  mainServerUrl: defaultMainServerUrl(),
  cdnUrl: defaultCdnUrl(),
  cdcUrl: defaultCdcUrl(),
  /** When unset the nginx probe is skipped entirely. */
  nginxUrl: envString('HEALTH_NGINX_URL', ''),
} as const;
