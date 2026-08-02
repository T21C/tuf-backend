/**
 * Redis ops that flood Sentry when left unfiltered (CDC/event-bus streams, pub/sub).
 * Cache GET/SET/TTL/SADD stay visible as child spans under HTTP transactions.
 *
 * Span names from @sentry/node redis instrumentation: `redis-${commandName}`.
 */
const NOISY_REDIS_COMMAND =
  /^(?:redis[-.])?(?:xreadgroup|xread|xack|xadd|xgroup|xinfo|xlen|xpending|xrange|xrevrange|xtrim|publish|spublish|subscribe|psubscribe|ssubscribe|unsubscribe|punsubscribe|sunsubscribe|connect)\b/i;

/**
 * Root transactions created when a Redis command runs outside an HTTP/request scope
 * (CDC consumers, outbox relay, job pub/sub). Always drop — keep redis as child spans only.
 */
export function isOrphanRedisTransaction(transactionName: string): boolean {
  const name = transactionName.trim();
  if (/^redis[-.]/i.test(name)) return true;
  // Rare: command-only roots without the `redis-` prefix
  if (NOISY_REDIS_COMMAND.test(name)) return true;
  return false;
}

/** `ignoreSpans` entries for Sentry.init — keep GET/SET/TTL/SADD/DEL visible. */
export function redisNoiseIgnoreSpans(): Array<{ name: RegExp } | { op: RegExp }> {
  return [
    { name: NOISY_REDIS_COMMAND },
    { op: /^db\.redis\.connect$/i },
  ];
}
