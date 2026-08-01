import * as Sentry from '@sentry/node';

/**
 * Active trace/span ids for Winston warn/error lines.
 * Empty when Sentry is disabled or no span is active.
 */
export function getTraceLogFields(): { trace_id?: string; span_id?: string } {
  try {
    if (!Sentry.isInitialized()) {
      return {};
    }
    const data = Sentry.getTraceData();
    const traceId =
      (data['sentry-trace'] && String(data['sentry-trace']).split('-')[0]) ||
      undefined;
    // Prefer baggage/trace helpers when present; span id is second segment of sentry-trace
    const sentryTrace = data['sentry-trace'];
    let spanId: string | undefined;
    if (typeof sentryTrace === 'string') {
      const parts = sentryTrace.split('-');
      if (parts.length >= 2) spanId = parts[1];
    }
    const out: { trace_id?: string; span_id?: string } = {};
    if (traceId) out.trace_id = traceId;
    if (spanId) out.span_id = spanId;
    return out;
  } catch {
    return {};
  }
}
