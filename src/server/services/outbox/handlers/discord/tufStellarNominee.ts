import {Webhook, MessageBuilder} from '@/misc/webhook/index.js';
import {clientUrlEnv} from '@/config/app.config.js';
import {logger} from '@/server/services/core/LoggerService.js';
import type {DiscordTufStellarNomineePayload} from '@/server/services/outbox/events.js';

const botAvatar = process.env.BOT_AVATAR_URL || '';

export async function handleDiscordTufStellarNominee(
  payload: DiscordTufStellarNomineePayload,
): Promise<void> {
  const webhookUrl = (process.env.TUFSTELLAR_NOMINEES_WEBHOOK_URL || '').trim();
  if (!webhookUrl) {
    logger.warn('TUFSTELLAR_NOMINEES_WEBHOOK_URL is not set; cannot deliver nominee notice');
    throw new Error('TUFSTELLAR_NOMINEES_WEBHOOK_URL is not set');
  }

  const siteUrl = String(clientUrlEnv || '').replace(/\/$/, '');
  const profilePath = payload.playerId
    ? `/profile/${payload.playerId}`
    : `/profile/${payload.userId}`;
  const profileUrl = siteUrl ? `${siteUrl}${profilePath}` : profilePath;

  const hook = new Webhook({url: webhookUrl, throwErrors: true});
  hook.setUsername('TUFStellar nominees');
  if (botAvatar) {
    hook.setAvatar(botAvatar);
  }

  const embed = new MessageBuilder()
    .setAuthor(payload.username, payload.avatarUrl || '', profileUrl)
    .setTitle(`${payload.username} reached 100 ratings this month`)
    .setURL(profileUrl)
    .setDescription('Nominee notice for one month of TUFStellar.')
    .setColor('#d4af37')
    .setTimestamp()
    .addField('User ID', payload.userId, true)
    .addField(
      'Player ID',
      payload.playerId != null ? String(payload.playerId) : '—',
      true,
    )
    .addField('Month', payload.monthKey, true)
    .addField(
      'Official ratings this month',
      String(payload.officialRatingsThisMonth),
      true,
    );

  await hook.send(embed);
}
