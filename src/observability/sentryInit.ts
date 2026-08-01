import * as Sentry from '@sentry/node';
import { redactSentryEvent, redactSentryTransaction } from './redactForSentry.js';
import { extractPathFromSamplingContext, isTraceDenylistedPath } from './traceDenylist.js';
import { shouldKeepTransaction } from './transactionKeep.js';
import {
  isElasticsearchOutgoingUrl,
  isOrphanElasticsearchClientTransaction,
} from './elasticsearchNoise.js';

let sentryEnabled = false;

export function isSentryEnabled(): boolean {
  return sentryEnabled;
}

function buildTracePropagationTargets(): Array<string | RegExp> {
  const targets: Array<string | RegExp> = [
    'localhost',
    '127.0.0.1',
    /^https?:\/\/127\.0\.0\.1(?::\d+)?/i,
    /^https?:\/\/localhost(?::\d+)?/i,
    /^https?:\/\/([a-z0-9-]+\.)?tuforums\.com/i,
  ];
  for (const key of ['CDN_URL', 'LOCAL_CDN_URL'] as const) {
    const raw = process.env[key]?.trim();
    if (!raw) continue;
    try {
      const origin = new URL(raw).origin;
      targets.push(origin);
      targets.push(new RegExp(`^${origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'));
    } catch {
      targets.push(raw);
    }
  }
  return targets;
}

/**
 * Initialize Sentry once. No-ops when SENTRY_DSN is unset (F10-C).
 */
export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN?.trim();
  if (!dsn) {
    sentryEnabled = false;
    return;
  }

  if (!process.env.SENTRY_SERVER_NAME?.trim()) {
    // Entrypoints may set this before import; default remains empty → SDK omits.
  }

  const release =
    process.env.SENTRY_RELEASE?.trim() || process.env.GIT_SHA?.trim() || undefined;

  Sentry.init({
    dsn,
    enabled: true,
    environment:
      process.env.SENTRY_ENVIRONMENT?.trim() || process.env.NODE_ENV || 'development',
    release,
    serverName: process.env.SENTRY_SERVER_NAME?.trim() || undefined,
    sendDefaultPii: false,
    integrations: (defaults) => {
      const filtered = defaults.filter(
        (integration) =>
          // Redis: CDC XREADGROUP / cache noise
          integration.name !== 'Redis' &&
          // Replace default Http with ES-aware ignore list below
          integration.name !== 'Http',
      );
      return [
        ...filtered,
        Sentry.httpIntegration({
          // Drop raw http.client to ES (health, HEAD exists, sniff, _search transport).
          // High-level db.elasticsearch spans still come from clientSpanProxy.
          ignoreOutgoingRequests: (url) => isElasticsearchOutgoingUrl(url),
        }),
      ];
    },
    ignoreSpans: [
      { op: 'db.redis' },
      { op: 'db.redis.connect' },
      { op: /^db\.redis/ },
      { name: /^redis[.-]/i },
    ],
    tracePropagationTargets: buildTracePropagationTargets(),
    tracesSampler: (samplingContext) => {
      const path = extractPathFromSamplingContext(samplingContext);
      const name = samplingContext.name || '';
      if (isTraceDenylistedPath(path) || isTraceDenylistedPath(name)) {
        return 0;
      }
      if (/^redis[.-]/i.test(name) || (/\bredis\b/i.test(name) && /xread|sadd|get|set|publish/i.test(name))) {
        return 0;
      }
      if (isOrphanElasticsearchClientTransaction(name)) {
        return 0;
      }
      return 1;
    },
    beforeSend(event) {
      return redactSentryEvent(event as unknown as Record<string, unknown>) as unknown as typeof event;
    },
    beforeSendTransaction(event) {
      const tx = (event as { transaction?: string }).transaction || '';
      if (/^redis[.-]/i.test(tx) || (/redis/i.test(tx) && !/http\.(server|client)/i.test(tx))) {
        return null;
      }
      if (isOrphanElasticsearchClientTransaction(tx)) {
        return null;
      }
      if (!shouldKeepTransaction(event as Parameters<typeof shouldKeepTransaction>[0])) {
        return null;
      }
      return redactSentryTransaction(
        event as unknown as Record<string, unknown>,
      ) as unknown as typeof event;
    },
  });

  sentryEnabled = Sentry.isInitialized();
}
