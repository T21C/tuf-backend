import { redactSensitiveText } from '@/server/services/core/LoggerService.js';

const SENSITIVE_KEY_RE = /password|token|secret|authorization|cookie|set-cookie|cdn-ingest|ingest-key/i;

function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[Truncated]';
  if (typeof value === 'string') return redactSensitiveText(value);
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactSensitiveText(value.message),
      stack: value.stack ? redactSensitiveText(value.stack) : undefined,
    };
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v, depth + 1));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_RE.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redactValue(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

function scrubRequestData(data: Record<string, unknown> | undefined): void {
  if (!data) return;
  if ('cookies' in data) data.cookies = '[REDACTED]';
  if ('headers' in data && data.headers && typeof data.headers === 'object') {
    const headers = { ...(data.headers as Record<string, unknown>) };
    for (const key of Object.keys(headers)) {
      if (SENSITIVE_KEY_RE.test(key)) {
        headers[key] = '[REDACTED]';
      } else if (typeof headers[key] === 'string') {
        headers[key] = redactSensitiveText(headers[key] as string);
      }
    }
    data.headers = headers;
  }
  if ('data' in data) data.data = '[REDACTED]';
  if ('query_string' in data && typeof data.query_string === 'string') {
    data.query_string = redactSensitiveText(data.query_string);
  }
}

/**
 * Scrub PII/secrets from Sentry error events (aligned with Winston redaction).
 */
export function redactSentryEvent<T extends Record<string, unknown>>(event: T): T {
  const e = event as T & {
    message?: string;
    request?: Record<string, unknown>;
    user?: Record<string, unknown>;
    extra?: Record<string, unknown>;
    contexts?: Record<string, unknown>;
    breadcrumbs?: Array<{ message?: string; data?: Record<string, unknown> }>;
    exception?: { values?: Array<{ value?: string; type?: string }> };
  };

  if (typeof e.message === 'string') {
    e.message = redactSensitiveText(e.message);
  }

  scrubRequestData(e.request);

  if (e.user) {
    const user = { ...e.user };
    for (const key of Object.keys(user)) {
      if (SENSITIVE_KEY_RE.test(key) || key === 'email' || key === 'ip_address') {
        delete user[key];
      }
    }
    e.user = user;
  }

  if (e.extra) {
    e.extra = redactValue(e.extra) as Record<string, unknown>;
  }

  if (e.exception?.values) {
    for (const ex of e.exception.values) {
      if (typeof ex.value === 'string') {
        ex.value = redactSensitiveText(ex.value);
      }
    }
  }

  if (Array.isArray(e.breadcrumbs)) {
    for (const crumb of e.breadcrumbs) {
      if (typeof crumb.message === 'string') {
        crumb.message = redactSensitiveText(crumb.message);
      }
      if (crumb.data) {
        crumb.data = redactValue(crumb.data) as Record<string, unknown>;
      }
    }
  }

  return e;
}

/**
 * Scrub transaction/span payloads before send.
 */
export function redactSentryTransaction<T extends Record<string, unknown>>(event: T): T {
  const e = event as T & {
    request?: Record<string, unknown>;
    contexts?: Record<string, unknown>;
    tags?: Record<string, unknown>;
  };
  scrubRequestData(e.request);
  if (e.tags) {
    e.tags = redactValue(e.tags) as Record<string, unknown>;
  }
  return e;
}
