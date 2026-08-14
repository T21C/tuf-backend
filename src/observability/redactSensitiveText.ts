/**
 * Shared secret/PII redaction for Winston logs and Sentry payloads.
 * Pattern-based first, then replace known sensitive process.env values.
 */

const SENSITIVE_ENV_KEY_RE =
  /(?:TOKEN|SECRET|PASSWORD|PASSWD|WEBHOOK|HOOK|API[_-]?KEY|PRIVATE[_-]?KEY|AUTH|DSN|SALT|CREDENTIAL|DATABASE_URL|REDIS_URL|MONGO_URL)/i;

const SKIP_ENV_KEYS = new Set([
  'NODE_ENV',
  'MODE',
  'PORT',
  'LOG_LEVEL',
  'PWD',
  'HOME',
  'PATH',
  'USER',
  'SHELL',
  'TERM',
]);

const MIN_ENV_SECRET_LENGTH = 16;

let envSecretCache: string[] | null = null;

export function resetSensitiveEnvRedactionCache(): void {
  envSecretCache = null;
}

function collectEnvSecrets(): string[] {
  if (envSecretCache) return envSecretCache;
  const found: string[] = [];
  for (const [key, raw] of Object.entries(process.env)) {
    if (!raw || SKIP_ENV_KEYS.has(key) || !SENSITIVE_ENV_KEY_RE.test(key)) continue;
    for (const part of raw.split(/[\s,]+/)) {
      const trimmed = part.trim();
      if (trimmed.length >= MIN_ENV_SECRET_LENGTH) found.push(trimmed);
    }
  }
  found.sort((a, b) => b.length - a.length);
  envSecretCache = found;
  return found;
}

/**
 * Keys whose entire value is replaced (case-insensitive).
 * Includes HTTP span/header attribute names that embed the secret in the key.
 */
export const SENSITIVE_KEY_RE =
  /password|token|secret|authorization|cookie|set-cookie|cdn-ingest|ingest-key|webhook|hookurl|hook_url|api[_-]?key|private[_-]?key|request[._-]?body|response[._-]?body/i;

const MAX_REDACT_DEPTH = 8;

/**
 * Redact secrets and PII from log/Sentry strings before egress.
 */
export function redactSensitiveText(input: string): string {
  let out = input;
  // Discord webhook URLs (token is the last path segment). Keep snowflake id.
  out = out.replace(
    /https?:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/(\d+)\/[A-Za-z0-9_-]+(?:\/(?:slack|github))?(?:\?[^\s"'<>]*)?/gi,
    'https://discord.com/api/webhooks/$1/[REDACTED]',
  );
  // Slack incoming webhooks
  out = out.replace(
    /https?:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/gi,
    'https://hooks.slack.com/services/[REDACTED]',
  );
  // Stripe-like secret keys (not publishable pk_)
  out = out.replace(/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]+/g, '[REDACTED_STRIPE_KEY]');
  out = out.replace(/\bwhsec_[A-Za-z0-9]+/g, '[REDACTED_WEBHOOK_SECRET]');
  // Emails
  out = out.replace(
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    '[REDACTED_EMAIL]',
  );
  // MailerSend API tokens
  out = out.replace(/\bmlsn\.[A-Za-z0-9._-]+/gi, 'mlsn.[REDACTED]');
  // Bearer tokens
  out = out.replace(/\bBearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer [REDACTED]');
  // JWT-shaped
  out = out.replace(
    /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    '[REDACTED_JWT]',
  );
  // Query/body token or code params
  out = out.replace(/([?&](?:token|code)=)[^&\s"']+/gi, '$1[REDACTED]');
  // Long hex blobs (opaque tokens / hashes)
  out = out.replace(/\b[a-f0-9]{32,}\b/gi, '[REDACTED_HEX]');

  for (const secret of collectEnvSecrets()) {
    if (out.includes(secret)) {
      out = out.split(secret).join('[REDACTED_ENV]');
    }
  }
  return out;
}

export function redactSensitiveValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_REDACT_DEPTH) return '[Truncated]';
  if (typeof value === 'string') return redactSensitiveText(value);
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactSensitiveText(value.message),
      stack: value.stack ? redactSensitiveText(value.stack) : undefined,
    };
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactSensitiveValue(v, depth + 1));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_RE.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redactSensitiveValue(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}
