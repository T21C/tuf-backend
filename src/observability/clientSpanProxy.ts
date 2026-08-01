import * as Sentry from '@sentry/node';
import { isSentryEnabled } from './sentryInit.js';

export type ClientSpanProxyOptions = {
  system: 'elasticsearch';
  op: 'db.elasticsearch';
  /** Method names that must not be wrapped (event emitters, lifecycle, etc.). */
  skipMethods?: string[];
  /**
   * If set, only these method names become spans (everything else is passed through).
   * Prefer this for ES so admin/health helpers stay quiet.
   */
  onlyMethods?: string[];
};

const DEFAULT_SKIP = new Set([
  'on',
  'off',
  'once',
  'addListener',
  'removeListener',
  'removeAllListeners',
  'prependListener',
  'prependOnceListener',
  'emit',
  'listeners',
  'rawListeners',
  'listenerCount',
  'eventNames',
  'setMaxListeners',
  'getMaxListeners',
  'connect',
  'quit',
  'disconnect',
  'close',
  'duplicate',
  'ref',
  'unref',
  'destroy',
]);

/**
 * Wrap a client so each I/O method becomes a Sentry span.
 * Returns the original client when Sentry is disabled.
 */
export function instrumentClientMethods<T extends object>(
  client: T,
  options: ClientSpanProxyOptions,
): T {
  if (!isSentryEnabled()) {
    return client;
  }

  const skip = new Set([
    ...DEFAULT_SKIP,
    ...(options.skipMethods ?? []).map((m) => m),
  ]);
  const only =
    options.onlyMethods && options.onlyMethods.length > 0
      ? new Set(options.onlyMethods)
      : null;

  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== 'string' || typeof value !== 'function') {
        return value;
      }
      if (skip.has(prop) || prop.startsWith('_')) {
        return value.bind(target);
      }
      if (only && !only.has(prop)) {
        return value.bind(target);
      }

      return (...args: unknown[]) =>
        Sentry.startSpan(
          {
            name: `${options.system}.${prop}`,
            op: options.op,
            attributes: {
              'db.system': options.system,
              'db.operation': prop,
            },
          },
          () => value.apply(target, args),
        );
    },
  });
}
