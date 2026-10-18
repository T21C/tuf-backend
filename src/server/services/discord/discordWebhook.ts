import {DiscordGuild} from '@/models/discord/index.js';
import {clientUrlEnv} from '@/config/app.config.js';
import {logger} from '@/server/services/core/LoggerService.js';

export type WebhookMessage = {
  id?: string;
  channel_id?: string;
};

export function levelUrl(levelId: number): string {
  const base = String(clientUrlEnv || 'http://localhost:5173').replace(/\/$/, '');
  return `${base}/levels/${levelId}`;
}

export async function executeWebhook(
  webhookUrl: string,
  body: Record<string, unknown>,
  query: Record<string, string>,
): Promise<WebhookMessage> {
  const url = new URL(webhookUrl);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Webhook ${response.status}: ${text.slice(0, 300)}`);
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as WebhookMessage;
  } catch {
    return {};
  }
}

export function webhookMissing(error: unknown): boolean {
  return error instanceof Error && /^Webhook 404\b/.test(error.message);
}

export async function activeGuildId(): Promise<string | null> {
  const guild = await DiscordGuild.findOne({
    where: {isActive: true},
    attributes: ['guildId'],
    order: [['id', 'ASC']],
  });
  return guild?.guildId ?? null;
}

export function jumpUrl(guildId: string | null, message: WebhookMessage): string | null {
  if (!guildId || !message.channel_id || !message.id) return null;
  return `https://discord.com/channels/${guildId}/${message.channel_id}/${message.id}`;
}

export function discordJumpTarget(url: string): {threadId: string; messageId: string} | null {
  const match = String(url || '').match(/discord(?:app)?\.com\/channels\/\d+\/(\d+)\/(\d+)/i);
  if (!match) return null;
  return {threadId: match[1], messageId: match[2]};
}

export async function discordBotToken(): Promise<string> {
  const guild = await DiscordGuild.findOne({
    where: {isActive: true},
    order: [['id', 'ASC']],
  });
  return guild?.getDataValue('botToken') || process.env.DISCORD_BOT_TOKEN || '';
}

export async function patchThread(threadId: string, token: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`https://discord.com/api/v10/channels/${threadId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bot ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

export async function deleteWebhookMessage(webhookUrl: string, messageId: string, threadId: string | null): Promise<void> {
  const base = new URL(webhookUrl);
  const target = new URL(`${base.origin}${base.pathname.replace(/\/$/, '')}/messages/${messageId}`);
  if (threadId) target.searchParams.set('thread_id', threadId);
  const response = await fetch(target, {method: 'DELETE'});
  if (response.status === 404) return;
  if (response.status === 400 && threadId) {
    target.searchParams.delete('thread_id');
    const retry = await fetch(target, {method: 'DELETE'});
    if (retry.status === 404 || retry.ok) return;
    const text = await retry.text();
    throw new Error(`Webhook ${retry.status}: ${text.slice(0, 300)}`);
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Webhook ${response.status}: ${text.slice(0, 300)}`);
  }
}

export function logRatingThreadFailure(scopeId: number, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  logger.warn('[rating-thread] Discord post failed', {scopeId, message});
  return message.slice(0, 500);
}
