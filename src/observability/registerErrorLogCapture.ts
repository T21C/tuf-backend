import * as Sentry from '@sentry/node';
import { logger } from '@/server/services/core/LoggerService.js';
import { isSentryEnabled } from './sentryInit.js';

const META_CAP = 8_000;

function findErrorInMeta(meta: unknown[]): Error | null {
  for (const item of meta) {
    if (item instanceof Error) return item;
    if (
      item &&
      typeof item === 'object' &&
      typeof (item as { message?: unknown }).message === 'string' &&
      typeof (item as { stack?: unknown }).stack === 'string' &&
      typeof (item as { name?: unknown }).name === 'string'
    ) {
      const obj = item as { name: string; message: string; stack: string };
      const err = new Error(obj.message);
      err.name = obj.name;
      err.stack = obj.stack;
      return err;
    }
  }
  return null;
}

function safeExtra(meta: unknown[]): Record<string, unknown> {
  try {
    const raw = JSON.stringify(meta);
    return {
      meta: raw.length > META_CAP ? `${raw.slice(0, META_CAP)}…[truncated]` : raw,
    };
  } catch {
    return { meta: '[unserializable]' };
  }
}

/**
 * Forward Winston `error` log replay events to Sentry (F1b-B).
 * Must not call logger.error (recursion).
 */
export function registerErrorLogCapture(): void {
  if (!isSentryEnabled()) {
    return;
  }

  logger.addLogReplayListener((event) => {
    if (event.level !== 'error') return;
    // Avoid feedback loops if Sentry internals ever log through Winston.
    if (event.message.startsWith('[LoggerService] log replay listener')) return;

    try {
      const err = findErrorInMeta(event.meta);
      if (err) {
        Sentry.captureException(err, {
          extra: { logMessage: event.message, ...safeExtra(event.meta) },
        });
      } else {
        Sentry.captureMessage(event.message, {
          level: 'error',
          extra: safeExtra(event.meta),
        });
      }
    } catch {
      // Intentionally swallow — never route back through Winston here.
    }
  });
}
