/** Thrown on Discord/Cloudflare 429 so callers (e.g. outbox) can wait the right amount. */
export class WebhookRateLimitError extends Error {
  readonly status = 429;
  readonly retryAfterMs: number;
  readonly isCloudflareBlock: boolean;
  readonly host: string;

  constructor(message: string, options: {
    retryAfterMs: number;
    isCloudflareBlock: boolean;
    host: string;
  }) {
    super(message);
    this.name = 'WebhookRateLimitError';
    this.retryAfterMs = options.retryAfterMs;
    this.isCloudflareBlock = options.isCloudflareBlock;
    this.host = options.host;
  }
}

/** Best-effort retry delay from thrown errors (WebhookRateLimitError or duck-typed). */
export function getErrorRetryAfterMs(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const value = (err as {retryAfterMs?: unknown}).retryAfterMs;
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

export function isWebhookRateLimitError(err: unknown): err is WebhookRateLimitError {
  return (
    err instanceof WebhookRateLimitError ||
    (!!err &&
      typeof err === 'object' &&
      (err as {name?: string}).name === 'WebhookRateLimitError' &&
      typeof (err as {retryAfterMs?: unknown}).retryAfterMs === 'number')
  );
}
