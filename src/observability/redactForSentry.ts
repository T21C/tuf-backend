import {
  redactSensitiveText,
  redactSensitiveValue,
  SENSITIVE_KEY_RE,
} from './redactSensitiveText.js';

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
  // Incoming HTTP bodies can contain env values (webhook URLs, keys). Drop entirely.
  if ('data' in data) data.data = '[REDACTED]';
  if ('query_string' in data && typeof data.query_string === 'string') {
    data.query_string = redactSensitiveText(data.query_string);
  }
  if (typeof data.url === 'string') {
    data.url = redactSensitiveText(data.url);
  }
}

function redactExceptionValues(
  exception: { values?: Array<Record<string, unknown>> } | undefined,
): void {
  if (!exception?.values) return;
  for (const ex of exception.values) {
    if (typeof ex.value === 'string') {
      ex.value = redactSensitiveText(ex.value);
    }
    if (typeof ex.type === 'string') {
      ex.type = redactSensitiveText(ex.type);
    }
    const frames = (ex.stacktrace as { frames?: Array<Record<string, unknown>> } | undefined)
      ?.frames;
    if (!Array.isArray(frames)) continue;
    for (const frame of frames) {
      if (frame.vars && typeof frame.vars === 'object') {
        frame.vars = redactSensitiveValue(frame.vars) as Record<string, unknown>;
      }
      if (typeof frame.abs_path === 'string') {
        frame.abs_path = redactSensitiveText(frame.abs_path);
      }
    }
  }
}

/**
 * Scrub PII/secrets from Sentry error events (aligned with Winston redaction).
 */
export function redactSentryEvent<T extends Record<string, unknown>>(event: T): T {
  const e = event as T & {
    message?: string;
    culprit?: string;
    transaction?: string;
    request?: Record<string, unknown>;
    user?: Record<string, unknown>;
    extra?: Record<string, unknown>;
    contexts?: Record<string, unknown>;
    tags?: Record<string, unknown>;
    breadcrumbs?: Array<{ message?: string; data?: Record<string, unknown> }>;
    exception?: { values?: Array<Record<string, unknown>> };
    spans?: Array<Record<string, unknown>>;
    fingerprint?: unknown;
  };

  if (typeof e.message === 'string') {
    e.message = redactSensitiveText(e.message);
  }
  if (typeof e.culprit === 'string') {
    e.culprit = redactSensitiveText(e.culprit);
  }
  if (typeof e.transaction === 'string') {
    e.transaction = redactSensitiveText(e.transaction);
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
    e.extra = redactSensitiveValue(e.extra) as Record<string, unknown>;
  }
  if (e.contexts) {
    e.contexts = redactSensitiveValue(e.contexts) as Record<string, unknown>;
  }
  if (e.tags) {
    e.tags = redactSensitiveValue(e.tags) as Record<string, unknown>;
  }
  if (Array.isArray(e.fingerprint)) {
    e.fingerprint = e.fingerprint.map((item) =>
      typeof item === 'string' ? redactSensitiveText(item) : item,
    );
  }

  redactExceptionValues(e.exception);

  if (Array.isArray(e.breadcrumbs)) {
    for (const crumb of e.breadcrumbs) {
      if (typeof crumb.message === 'string') {
        crumb.message = redactSensitiveText(crumb.message);
      }
      if (crumb.data) {
        crumb.data = redactSensitiveValue(crumb.data) as Record<string, unknown>;
      }
    }
  }

  if (Array.isArray(e.spans)) {
    e.spans = e.spans.map((span) => redactSentrySpan(span));
  }

  return e;
}

/**
 * Scrub transaction payloads before send (legacy transaction events).
 */
export function redactSentryTransaction<T extends Record<string, unknown>>(event: T): T {
  const e = event as T & {
    transaction?: string;
    request?: Record<string, unknown>;
    contexts?: Record<string, unknown>;
    tags?: Record<string, unknown>;
    spans?: Array<Record<string, unknown>>;
  };
  if (typeof e.transaction === 'string') {
    e.transaction = redactSensitiveText(e.transaction);
  }
  scrubRequestData(e.request);
  if (e.tags) {
    e.tags = redactSensitiveValue(e.tags) as Record<string, unknown>;
  }
  if (e.contexts) {
    e.contexts = redactSensitiveValue(e.contexts) as Record<string, unknown>;
  }
  if (Array.isArray(e.spans)) {
    e.spans = e.spans.map((span) => redactSentrySpan(span));
  }
  return e;
}

/**
 * Scrub independently-sent HTTP/OTEL spans (`beforeSendSpan`).
 * Discord outages previously leaked webhook tokens via `http.url` / description.
 */
export function redactSentrySpan<T extends Record<string, unknown>>(span: T): T {
  const s = span as T & {
    description?: string;
    name?: string;
    data?: Record<string, unknown>;
    attributes?: Record<string, unknown>;
  };
  if (typeof s.description === 'string') {
    s.description = redactSensitiveText(s.description);
  }
  if (typeof s.name === 'string') {
    s.name = redactSensitiveText(s.name);
  }
  if (s.data && typeof s.data === 'object') {
    s.data = redactSensitiveValue(s.data) as Record<string, unknown>;
  }
  if (s.attributes && typeof s.attributes === 'object') {
    s.attributes = redactSensitiveValue(s.attributes) as Record<string, unknown>;
  }
  return s;
}

export function redactSentryBreadcrumb<T extends Record<string, unknown>>(breadcrumb: T): T {
  return redactSensitiveValue(breadcrumb) as T;
}
