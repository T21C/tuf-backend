import { createHash } from 'node:crypto';
import { redis } from '@/server/services/core/RedisService.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { WebhookRateLimitError } from '@/misc/webhook/classes/webhookErrors.js';
import { sseManager } from '@/misc/utils/server/sse.js';

const BLOCKED_UNTIL_KEY = 'discord:webhook:blockedUntil';
const BLOCKED_META_KEY = 'discord:webhook:blockedMeta';
const NEEDS_PROBE_KEY = 'discord:webhook:needsProbe';
const PROBE_LOCK_KEY = 'discord:webhook:probeLock';
const MAX_RETRY_AFTER_MS = 5 * 60_000;
const PROBE_LOCK_TTL_SECONDS = 30;
const PROBE_WAIT_FALLBACK_MS = 5_000;

export type DiscordWebhookBlockMeta = {
  isCloudflareBlock: boolean;
  setAt: number;
};

function broadcastGateChanged(retryAfterMs: number): void {
  try {
    sseManager.broadcast({
      type: 'discord.gate.changed',
      data: {
        blocked: retryAfterMs > 0,
        retryAfterMs,
        blockedUntil: retryAfterMs > 0 ? Date.now() + retryAfterMs : null,
      },
    });
  } catch (err) {
    logger.warn('[DiscordWebhookGate] SSE gate broadcast failed', err);
  }
}

function capRetryAfterMs(retryAfterMs: number): number {
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, Math.floor(retryAfterMs)));
}

/**
 * Shared Discord webhook ban / cooldown gate (Redis), so all processes agree
 * and HTTP + outbox can hard-reject while blocked.
 *
 * Probe lock is only used when recovering from a ban (`needsProbe`), not on
 * every healthy send — otherwise parallel webhooks infinite-loop on each other.
 */
export const DiscordWebhookGate = {
  async getBlockedUntilMs(): Promise<number> {
    const value = await redis.get<number>(BLOCKED_UNTIL_KEY);
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  },

  async getBlockedRemainingMs(): Promise<number> {
    const until = await this.getBlockedUntilMs();
    return Math.max(0, until - Date.now());
  },

  async getBlockMeta(): Promise<DiscordWebhookBlockMeta | null> {
    return redis.get<DiscordWebhookBlockMeta>(BLOCKED_META_KEY);
  },

  async isBlocked(): Promise<boolean> {
    return (await this.getBlockedRemainingMs()) > 0;
  },

  async needsProbe(): Promise<boolean> {
    const value = await redis.get<boolean | string | number>(NEEDS_PROBE_KEY);
    return value === true || value === 1 || value === '1' || value === 'true';
  },

  /**
   * Throws WebhookRateLimitError when the gate is active.
   * After a ban window expires, only one worker may probe Discord (`needsProbe`).
   * Healthy traffic (no recent ban) does not take the probe lock.
   */
  async assertNotBlocked(host = 'discord.com'): Promise<void> {
    const remainingMs = await this.getBlockedRemainingMs();
    if (remainingMs > 0) {
      const meta = await this.getBlockMeta();
      throw new WebhookRateLimitError(
        `Discord webhook gate active host=${host} retryAfterMs=${remainingMs} cloudflare=${!!meta?.isCloudflareBlock}`,
        {
          retryAfterMs: remainingMs,
          isCloudflareBlock: meta?.isCloudflareBlock ?? true,
          host,
        },
      );
    }

    if (!(await this.needsProbe())) {
      return;
    }

    const client = await redis.getClient();
    if (!client) return;

    try {
      const acquired = await client.set(PROBE_LOCK_KEY, String(Date.now()), {
        NX: true,
        EX: PROBE_LOCK_TTL_SECONDS,
      });
      if (acquired === null || acquired === undefined || acquired === false) {
        const ttlSeconds = await client.ttl(PROBE_LOCK_KEY);
        const waitMs =
          typeof ttlSeconds === 'number' && ttlSeconds > 0
            ? ttlSeconds * 1000
            : PROBE_WAIT_FALLBACK_MS;
        throw new WebhookRateLimitError(
          `Discord webhook probe in progress host=${host} retryAfterMs=${waitMs}`,
          {
            retryAfterMs: waitMs,
            isCloudflareBlock: true,
            host,
          },
        );
      }
    } catch (err) {
      if (err instanceof WebhookRateLimitError) throw err;
      logger.warn('[DiscordWebhookGate] probe lock failed; allowing send', err);
    }
  },

  async setBlocked(
    retryAfterMs: number,
    options: { isCloudflareBlock?: boolean } = {},
  ): Promise<number> {
    const capped = capRetryAfterMs(retryAfterMs);
    const until = Date.now() + capped;
    const existing = await this.getBlockedUntilMs();
    const finalUntil = Math.max(existing, until);
    const ttlSeconds = Math.max(1, Math.ceil((finalUntil - Date.now()) / 1000));

    await redis.set(BLOCKED_UNTIL_KEY, finalUntil, ttlSeconds);
    await redis.set(
      BLOCKED_META_KEY,
      {
        isCloudflareBlock: options.isCloudflareBlock ?? false,
        setAt: Date.now(),
      } satisfies DiscordWebhookBlockMeta,
      ttlSeconds,
    );
    // After the ban window, force a single-flight probe before opening the floodgates.
    await redis.set(NEEDS_PROBE_KEY, true, Math.max(ttlSeconds + 60, 120));
    // Prefer blockedUntil waits over probe-lock contention while the ban is active.
    await redis.del(PROBE_LOCK_KEY);

    logger.warn('[DiscordWebhookGate] blockedUntil set', {
      retryAfterMs: capped,
      blockedUntil: finalUntil,
      isCloudflareBlock: options.isCloudflareBlock ?? false,
    });

    broadcastGateChanged(Math.max(0, finalUntil - Date.now()));

    return finalUntil;
  },

  async clear(): Promise<void> {
    await redis.del(BLOCKED_UNTIL_KEY);
    await redis.del(BLOCKED_META_KEY);
    await redis.del(NEEDS_PROBE_KEY);
    await redis.del(PROBE_LOCK_KEY);
    broadcastGateChanged(0);
  },

  /** Call after a successful Discord webhook response. */
  async noteSuccessfulSend(): Promise<void> {
    const wasProbing = await this.needsProbe();
    await redis.del(NEEDS_PROBE_KEY);
    await redis.del(PROBE_LOCK_KEY);
    if (wasProbing) {
      broadcastGateChanged(0);
    }
  },

  async releaseProbeLock(): Promise<void> {
    await redis.del(PROBE_LOCK_KEY);
  },

  hashWebhookUrl(webhookUrl: string): string {
    return createHash('sha256').update(webhookUrl).digest('hex').slice(0, 16);
  },
};
