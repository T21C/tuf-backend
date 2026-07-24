import {sendWebhook, sendFile} from '../api/index.js';
import MessageBuilder from './messageBuilder.js';
import { logger } from '@/server/services/core/LoggerService.js';
import type {Response} from 'node-fetch';

const MAX_RATE_LIMIT_RETRIES = 3;
const MAX_ERROR_BODY_LENGTH = 500;

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
      if (this.throwErrors) throw new Error(err.message);
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

    try {
      let res = await sendWebhook(this.hookURL, endPayload);
      let rateLimitRetries = 0;

      // Handle rate limiting with proper retry logic
      while (res.status === 429 && this.retryOnLimit && rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
        rateLimitRetries++;
        const body = await parseWebhookResponse(res);
        const retryAfter =
          typeof body.json?.retry_after === 'number' ? body.json.retry_after : 1;
        const waitUntil = retryAfter * 1000;

        logger.warn(
          `[Webhook] Rate limited, retrying in ${waitUntil}ms (attempt ${rateLimitRetries}/${MAX_RATE_LIMIT_RETRIES}) host=${getWebhookHost(this.hookURL)} ${formatWebhookHttpError(res, body)}`,
        );

        await new Promise(resolve => setTimeout(resolve, waitUntil));
        res = await sendWebhook(this.hookURL, endPayload);
      }

      if (res.status === 429) {
        const body = await parseWebhookResponse(res);
        throw new Error(
          `Rate limit exceeded after ${MAX_RATE_LIMIT_RETRIES} retries host=${getWebhookHost(this.hookURL)} ${formatWebhookHttpError(res, body)}`,
        );
      } else if (res.status !== 204 && res.status !== 200) {
        const body = await parseWebhookResponse(res);
        throw new Error(
          `Webhook request failed host=${getWebhookHost(this.hookURL)} ${formatWebhookHttpError(res, body)}`,
        );
      }
    } catch (err: any) {
      logger.error(`[Webhook] Failed to send webhook: ${err.message}`, {
        host: getWebhookHost(this.hookURL),
        embedCount: endPayload.embeds?.length || 0,
        hasContent: !!endPayload.content,
        username: endPayload.username,
        errorName: err.name,
        errorCode: err.code,
        cause: err.cause?.message || err.cause,
        stack: err.stack,
      });
      if (this.throwErrors) throw new Error(err.message);
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
