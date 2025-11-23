import {sendWebhook, sendFile} from '../api/index.js';
import MessageBuilder from './messageBuilder.js';

export default class Webhook {
  private payload: any;
  private hookURL: string;
  private throwErrors: boolean;
  private retryOnLimit: boolean;

  constructor(options: any) {
    this.payload = {};

    if (typeof options === 'string') {
      this.hookURL = options;
      this.throwErrors = true;
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
          `Error sending webhook: ${res.statusCode} status code.`,
        );
      }
    } catch (err: any) {
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
      const res = await sendWebhook(this.hookURL, endPayload);

      if (res.status === 429 && this.retryOnLimit) {
        const body: any = await res.json();
        const waitUntil = body['retry_after'];

        setTimeout(() => sendWebhook(this.hookURL, endPayload), waitUntil);
      } else if (res.status !== 204) {
        console.log(endPayload);
        console.log(res);
        throw new Error(
          `Error sending webhook: ${res.status} status code. Response: ${await res.text()}`,
        );
      }
    } catch (err: any) {
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
