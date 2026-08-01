import { isTraceDenylistedPath } from './traceDenylist.js';

function parsePositiveNumber(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function transactionDurationMs(event: {
  timestamp?: number;
  start_timestamp?: number;
}): number | null {
  const start = event.start_timestamp;
  const end = event.timestamp;
  if (typeof start !== 'number' || typeof end !== 'number') return null;
  // Sentry timestamps are seconds (float)
  return (end - start) * 1000;
}

function httpStatusFromTransaction(event: {
  contexts?: { response?: { status_code?: number }; trace?: { status?: string } };
  tags?: Record<string, unknown>;
}): number | null {
  const code = event.contexts?.response?.status_code;
  if (typeof code === 'number') return code;
  const tag = event.tags?.['http.status_code'];
  if (typeof tag === 'number') return tag;
  if (typeof tag === 'string' && /^\d+$/.test(tag)) return Number(tag);
  return null;
}

function isErrorTransaction(event: {
  contexts?: { trace?: { status?: string }; response?: { status_code?: number } };
  tags?: Record<string, unknown>;
}): boolean {
  const status = event.contexts?.trace?.status;
  if (status && status !== 'ok' && status !== 'unknown') {
    return true;
  }
  const http = httpStatusFromTransaction(event);
  return http != null && http >= 500;
}

/**
 * Slow-first retention: keep slow, errors/5xx, or a small % of fast OK traces.
 * In development, keep all non-denylisted transactions for local repro.
 * Returns false when the transaction should be dropped (beforeSendTransaction → null).
 */
export function shouldKeepTransaction(event: {
  transaction?: string;
  timestamp?: number;
  start_timestamp?: number;
  contexts?: { response?: { status_code?: number }; trace?: { status?: string } };
  tags?: Record<string, unknown>;
}): boolean {
  const name = event.transaction || '';
  if (isTraceDenylistedPath(name)) {
    return false;
  }

  if (isDevelopmentTracing()) {
    return true;
  }

  if (isErrorTransaction(event)) {
    return true;
  }

  const thresholdMs = parsePositiveNumber(process.env.SLOW_ENDPOINT_THRESHOLD_MS, 3000);
  const durationMs = transactionDurationMs(event);
  if (durationMs != null && durationMs >= thresholdMs) {
    return true;
  }

  const fastRate = parsePositiveNumber(process.env.SENTRY_TRACES_FAST_SAMPLE_RATE, 0.05);
  return Math.random() < fastRate;
}

function isDevelopmentTracing(): boolean {
  const env =
    process.env.SENTRY_ENVIRONMENT?.trim() ||
    process.env.NODE_ENV?.trim() ||
    '';
  return env === 'development' || env === 'dev';
}
