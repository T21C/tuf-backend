import {sendWebhook, sendFile} from '../api/index.js';
import MessageBuilder from './messageBuilder.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { DiscordWebhookGate } from '@/server/services/discord/DiscordWebhookGate.js';
import {
  WebhookRateLimitError,
  getErrorRetryAfterMs,
} from './webhookErrors.js';
import type {Response} from 'node-fetch';

export {
  WebhookRateLimitError,
  getErrorRetryAfterMs,
} from './webhookErrors.js';
export { isWebhookRateLimitError } from './webhookErrors.js';

const MAX_RATE_LIMIT_RETRIES = 3;
const MAX_ERROR_BODY_LENGTH = 500;
const DEFAULT_DISCORD_RETRY_AFTER_MS = 5_000;
const DEFAULT_CLOUDFLARE_RETRY_AFTER_MS = 60_000;
const MAX_RETRY_AFTER_MS = 5 * 60_000;

type ParsedWebhookResponse = {
  text: string;
  json: Record<string, unknown> | null;
};

const truncate = (value: string, max = MAX_ERROR_BODY_LENGTH): string =>
  value.length > max ? `${value.slice(0, max)}…` : value;

const getWebhookHost = (hookURL: string): string => {
  try {
    return new URL(hookURL).host;
  } catch {
    return 'invalid-url';
  }
};

const parseWebhookResponse = async (
  res: Response,
): Promise<ParsedWebhookResponse> => {
  const text = await res.text();
  const trimmed = text.trim();
  const contentType = res.headers.get('content-type') || '';
  const looksLikeJson =
    contentType.includes('application/json') ||
    trimmed.startsWith('{') ||
    trimmed.startsWith('[');

  if (!looksLikeJson || !trimmed) {
    return {text, json: null};
  }

  try {
    return {text, json: JSON.parse(trimmed)};
  } catch {
    return {text, json: null};
  }
};

const isCloudflareBlockedResponse = (
  res: Response,
  body: ParsedWebhookResponse,
): boolean => {
  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  const text = body.text.toLowerCase();
  return (
    contentType.includes('text/html') ||
    text.includes('cloudflare') ||
    text.includes('access denied') ||
    text.includes('<!doctype')
  );
};

const resolveRetryAfterMs = (
  res: Response,
  body: ParsedWebhookResponse,
  isCloudflareBlock: boolean,
): number => {
  let resolvedMs: number | undefined;

  const header = res.headers.get('retry-after');
  if (header) {
    const asSeconds = Number(header);
    if (!Number.isNaN(asSeconds)) {
      resolvedMs = asSeconds * 1000;
    } else {
      const asDate = Date.parse(header);
      if (!Number.isNaN(asDate)) {
        resolvedMs = asDate - Date.now();
      }
    }
  }

  if (resolvedMs === undefined && typeof body.json?.retry_after === 'number') {
    resolvedMs = body.json.retry_after * 1000;
  }

  if (resolvedMs === undefined) {
    resolvedMs = isCloudflareBlock
      ? DEFAULT_CLOUDFLARE_RETRY_AFTER_MS
      : DEFAULT_DISCORD_RETRY_AFTER_MS;
  }

  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, resolvedMs));
};

const formatWebhookHttpError = (
  res: Response,
  body: ParsedWebhookResponse,
): string => {
  const contentType = res.headers.get('content-type') || 'unknown';
  const preview = truncate(body.text.replace(/\s+/g, ' ').trim() || '(empty body)');
  const discordCode =
    body.json && typeof body.json.code === 'number' ? ` discordCode=${body.json.code}` : '';
  const discordMessage =
    body.json && typeof body.json.message === 'string'
      ? ` discordMessage=${body.json.message}`
      : '';

  return `HTTP ${res.status} ${res.statusText || ''} content-type=${contentType}${discordCode}${discordMessage} body=${preview}`.trim();
};

const createRateLimitError = async (
  host: string,
  res: Response,
  body: ParsedWebhookResponse,
  messagePrefix: string,
): Promise<WebhookRateLimitError> => {
  const isCloudflareBlock = isCloudflareBlockedResponse(res, body);
  const retryAfterMs = resolveRetryAfterMs(res, body, isCloudflareBlock);
  await DiscordWebhookGate.setBlocked(retryAfterMs, {isCloudflareBlock});

  return new WebhookRateLimitError(
    `${messagePrefix} host=${host} retryAfterMs=${retryAfterMs} cloudflare=${isCloudflareBlock} ${formatWebhookHttpError(res, body)}`,
    {retryAfterMs, isCloudflareBlock, host},
  );
};

export default class Webhook {
  private payload: any;
  private hookURL: string;
  private throwErrors: boolean;
  private retryOnLimit: boolean;

  constructor(options: any) {
    this.payload = {};

    if (typeof options === 'string') {
      this.hookURL = options;
      this.throwErrors = false;
      this.retryOnLimit = true;
    } else {
      this.hookURL = options.url;
      this.throwErrors =
        options.throwErrors === undefined ? true : options.throwErrors;
      this.retryOnLimit =
        options.retryOnLimit === undefined ? true : options.retryOnLimit;
    }
  }

  setUsername(username: string) {
    this.payload.username = username;

    return this;
  }

  setAvatar(avatarURL: string) {
    this.payload.avatar_url = avatarURL;

    return this;
  }

  async sendFile(filePath: string) {
    try {
      const res = await sendFile(this.hookURL, filePath, this.payload);

      if (res.statusCode !== 200) {
        throw new Error(
          `Error sending webhook file: ${res.statusCode} status code.`,
        );
      }
    } catch (err: any) {
      logger.error(`[Webhook] Failed to send file: ${err.message}`, { filePath });
      if (this.throwErrors) throw err;
    }
  }

  async send(payload: any) {
    let endPayload = {
      ...this.payload,
    };

    if (typeof payload === 'string') {
      endPayload.content = payload;
    } else {
      endPayload = {
        ...endPayload,
        ...payload.getJSON(),
      };
    }

    // Filter out empty embeds (embeds with only empty fields array and no other properties)
    if (endPayload.embeds && Array.isArray(endPayload.embeds)) {
      endPayload.embeds = endPayload.embeds.filter((embed: any) => {
        // Check if embed has any meaningful content
        const hasContent =
          embed.title ||
          embed.description ||
          embed.author ||
          embed.footer ||
          embed.image ||
          embed.thumbnail ||
          embed.timestamp ||
          embed.color ||
          (embed.fields && embed.fields.length > 0) ||
          embed.url;
        return hasContent;
      });

      // Remove embeds array if it's empty after filtering
      if (endPayload.embeds.length === 0) {
        endPayload.embeds = undefined;
      }
    } else if (endPayload.embeds && endPayload.embeds.length === 0) {
      endPayload.embeds = undefined;
    }

    const host = getWebhookHost(this.hookURL);

    try {
      await DiscordWebhookGate.assertNotBlocked(host);

      let res = await sendWebhook(this.hookURL, endPayload);
      let rateLimitRetries = 0;

      while (res.status === 429) {
        const body = await parseWebhookResponse(res);
        const isCloudflareBlock = isCloudflareBlockedResponse(res, body);

        // Cloudflare/HTML 429s are bans/challenges — short retries only make it worse.
        // Leave recovery to the outbox / caller with a long retryAfterMs.
        if (isCloudflareBlock || !this.retryOnLimit) {
          throw await createRateLimitError(
            host,
            res,
            body,
            isCloudflareBlock
              ? 'Webhook blocked by Cloudflare'
              : 'Webhook rate limited',
          );
        }

        // Only retry real Discord JSON rate limits with an explicit wait.
        if (rateLimitRetries >= MAX_RATE_LIMIT_RETRIES) {
          throw await createRateLimitError(
            host,
            res,
            body,
            `Rate limit exceeded after ${MAX_RATE_LIMIT_RETRIES} retries`,
          );
        }

        const retryAfterMs = resolveRetryAfterMs(res, body, false);
        rateLimitRetries++;
        await DiscordWebhookGate.setBlocked(retryAfterMs, {isCloudflareBlock: false});
        logger.warn(
          `[Webhook] Rate limited, retrying in ${retryAfterMs}ms (attempt ${rateLimitRetries}/${MAX_RATE_LIMIT_RETRIES}) host=${host} ${formatWebhookHttpError(res, body)}`,
        );

        await new Promise(resolve => setTimeout(resolve, retryAfterMs));
        res = await sendWebhook(this.hookURL, endPayload);
      }

      if (res.status !== 204 && res.status !== 200) {
        const body = await parseWebhookResponse(res);
        throw new Error(
          `Webhook request failed host=${host} ${formatWebhookHttpError(res, body)}`,
        );
      }

      // Successful send — clear recovery probe state so peers can send normally.
      await DiscordWebhookGate.noteSuccessfulSend();
    } catch (err: any) {
      const isProbeWait =
        typeof err?.message === 'string' &&
        err.message.includes('probe in progress');
      const logFn = isProbeWait ? logger.warn.bind(logger) : logger.error.bind(logger);
      logFn(`[Webhook] Failed to send webhook: ${err.message}`, {
        host,
        embedCount: endPayload.embeds?.length || 0,
        hasContent: !!endPayload.content,
        username: endPayload.username,
        errorName: err.name,
        errorCode: err.code,
        retryAfterMs: err.retryAfterMs,
        isCloudflareBlock: err.isCloudflareBlock,
        cause: err.cause?.message || err.cause,
        stack: isProbeWait ? undefined : err.stack,
      });
      if (this.throwErrors) throw err;
    }
  }

  async info(
    title: string,
    fieldName: string,
    fieldValue: string,
    inline: boolean,
  ) {
    const embed = new MessageBuilder()
      .setTitle(title)
      .setTimestamp()
      .setColor(4037805);

    if (fieldName !== undefined && fieldValue !== undefined) {
      embed.addField(fieldName, fieldValue, inline);
    }

    await this.send(embed);
  }

  async success(
    title: string,
    fieldName: string,
    fieldValue: string,
    inline: boolean,
  ) {
    const embed = new MessageBuilder()
      .setTitle(title)
      .setTimestamp()
      .setColor(65340);

    if (fieldName !== undefined && fieldValue !== undefined) {
      embed.addField(fieldName, fieldValue, inline);
    }

    await this.send(embed);
  }

  async warning(
    title: string,
    fieldName: string,
    fieldValue: string,
    inline: boolean,
  ) {
    const embed = new MessageBuilder()
      .setTitle(title)
      .setTimestamp()
      .setColor(16763904);

    if (fieldName !== undefined && fieldValue !== undefined) {
      embed.addField(fieldName, fieldValue, inline);
    }

    await this.send(embed);
  }

  async error(
    title: string,
    fieldName: string,
    fieldValue: string,
    inline: boolean,
  ) {
    const embed = new MessageBuilder()
      .setTitle(title)
      .setTimestamp()
      .setColor(16729149);

    if (fieldName !== undefined && fieldValue !== undefined) {
      embed.addField(fieldName, fieldValue, inline);
    }

    await this.send(embed);
  }
}
