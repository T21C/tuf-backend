import {sendWebhook, sendFile} from '../api/index.js';
import MessageBuilder from './messageBuilder.js';
import { logger } from '../../../server/services/LoggerService.js';

const MAX_RATE_LIMIT_RETRIES = 3;

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
        const body: any = await res.json();
        const waitUntil = (body['retry_after'] || 1) * 1000; // Convert to ms, default 1 second
        
        logger.warn(`[Webhook] Rate limited, retrying in ${waitUntil}ms (attempt ${rateLimitRetries}/${MAX_RATE_LIMIT_RETRIES})`);
        
        await new Promise(resolve => setTimeout(resolve, waitUntil));
        res = await sendWebhook(this.hookURL, endPayload);
      }

      if (res.status === 429) {
        throw new Error(`Rate limit exceeded after ${MAX_RATE_LIMIT_RETRIES} retries`);
      } else if (res.status !== 204 && res.status !== 200) {
        const responseText = await res.text();
        throw new Error(`HTTP ${res.status}: ${responseText}`);
      }
    } catch (err: any) {
      // Log all errors with context
      logger.error(`[Webhook] Failed to send webhook: ${err.message}`, {
        embedCount: endPayload.embeds?.length || 0,
        hasContent: !!endPayload.content,
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
