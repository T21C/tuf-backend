import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isSentryTraceIdentity,
  isTracingFieldKey,
  redactSensitiveText,
  redactSensitiveValue,
} from './redactSensitiveText.js';
import { redactSentrySpan, redactSentryTransaction } from './redactForSentry.js';

const TRACE_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SPAN_ID = 'bbbbbbbbbbbbbbbb';

test('trace/span/git ids and sentry-trace headers are not hex-scrubbed', () => {
  assert.equal(isSentryTraceIdentity(TRACE_ID), true);
  assert.equal(isSentryTraceIdentity(SPAN_ID), true);
  assert.equal(redactSensitiveText(TRACE_ID), TRACE_ID);
  assert.equal(redactSensitiveText(SPAN_ID), SPAN_ID);
  const header = `${TRACE_ID}-${SPAN_ID}-1`;
  assert.equal(redactSensitiveText(header), header);
  assert.equal(
    redactSensitiveText(`00-${TRACE_ID}-${SPAN_ID}-01`),
    `00-${TRACE_ID}-${SPAN_ID}-01`,
  );
});

test('32-char hex inside a URL is still redacted', () => {
  const url = `https://api.tuforums.com/v2/session/${TRACE_ID}`;
  assert.match(redactSensitiveText(url), /\[REDACTED_HEX\]/);
  assert.equal(redactSensitiveText(url).includes(TRACE_ID), false);
});

test('tracing field keys are passed through', () => {
  assert.equal(isTracingFieldKey('trace_id'), true);
  assert.equal(isTracingFieldKey('sentry.trace_id'), true);
  assert.equal(isTracingFieldKey('parent_span_id'), true);
  assert.equal(isTracingFieldKey('sentry-trace'), true);
  assert.equal(isTracingFieldKey('authorization'), false);

  const out = redactSensitiveValue({
    trace_id: TRACE_ID,
    span_id: SPAN_ID,
    'sentry-trace': `${TRACE_ID}-${SPAN_ID}-1`,
    authorization: 'Bearer secret-token-value',
    'http.url': `https://discord.com/api/webhooks/123/${'A'.repeat(40)}`,
  }) as Record<string, unknown>;

  assert.equal(out.trace_id, TRACE_ID);
  assert.equal(out.span_id, SPAN_ID);
  assert.equal(out.authorization, '[REDACTED]');
  assert.match(String(out['http.url']), /\[REDACTED\]/);
});

test('beforeSendSpan keeps trace ids and still scrubs webhook URLs', () => {
  const span = redactSentrySpan({
    name: 'GET /v2/auth/session',
    description: 'GET /v2/auth/session',
    trace_id: TRACE_ID,
    span_id: SPAN_ID,
    parent_span_id: 'cccccccccccccccc',
    attributes: {
      trace_id: TRACE_ID,
      'sentry.trace_id': TRACE_ID,
      'http.url': `https://discord.com/api/webhooks/999/${'B'.repeat(40)}`,
    },
  });

  assert.equal(span.trace_id, TRACE_ID);
  assert.equal(span.span_id, SPAN_ID);
  assert.equal(span.attributes?.trace_id, TRACE_ID);
  assert.equal(span.attributes?.['sentry.trace_id'], TRACE_ID);
  assert.match(String(span.attributes?.['http.url']), /\[REDACTED\]/);
});

test('transaction contexts.trace ids survive redaction', () => {
  const event = redactSentryTransaction({
    transaction: 'GET /v2/levels',
    contexts: {
      trace: {
        trace_id: TRACE_ID,
        span_id: SPAN_ID,
        parent_span_id: 'cccccccccccccccc',
        status: 'ok',
      },
    },
  });
  const trace = event.contexts?.trace as Record<string, unknown>;
  assert.equal(trace.trace_id, TRACE_ID);
  assert.equal(trace.span_id, SPAN_ID);
  assert.equal(trace.status, 'ok');
});
