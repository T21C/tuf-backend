import {Webhook, MessageBuilder} from '@/misc/webhook/index.js';
import {clientUrlEnv} from '@/config/app.config.js';
import {logger} from '@/server/services/core/LoggerService.js';
import type {
  DiscordTufStellarNomineePayload,
  TufStellarNomineeKind,
} from '@/server/services/outbox/events.js';
import {MONTHLY_NOMINEE_THRESHOLD} from '@/server/services/tufStellar/tufStellarNominee.js';

const botAvatar = process.env.BOT_AVATAR_URL || '';

const NOTICES: Record<TufStellarNomineeKind, {noun: string; countLabel: string}> = {
  rating: {
    noun: 'ratings',
    countLabel: 'Official ratings this month',
  },
  curation: {
    noun: 'curation ratings',
    countLabel: 'Curation ratings this month',
  },
};

function nomineeKind(payload: DiscordTufStellarNomineePayload): TufStellarNomineeKind {
  return payload.kind === 'curation' ? 'curation' : 'rating';
}

function nomineeCount(payload: DiscordTufStellarNomineePayload): number {
  if (typeof payload.officialCountThisMonth === 'number') return payload.officialCountThisMonth;
  if (typeof payload.officialRatingsThisMonth === 'number') return payload.officialRatingsThisMonth;
  return MONTHLY_NOMINEE_THRESHOLD;
}

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
  const notice = NOTICES[nomineeKind(payload)];
  const count = nomineeCount(payload);

  const hook = new Webhook({url: webhookUrl, throwErrors: true});
  hook.setUsername('TUFStellar nominees');
  if (botAvatar) {
    hook.setAvatar(botAvatar);
  }

  const embed = new MessageBuilder()
    .setAuthor(payload.username, payload.avatarUrl || '', profileUrl)
    .setTitle(`${payload.username} reached ${count} ${notice.noun} this month`)
    .setURL(profileUrl)
    .setDescription('Nominee notice for one month of TUFStellar.')
    .setColor('#d4af37')
    .setTimestamp()
    .addField(
      'Player ID',
      payload.playerId != null ? String(payload.playerId) : '—',
      true,
    )
    .addField('Month', payload.monthKey, true)
    .addField(notice.countLabel, String(count), true);

  await hook.send(embed);
}
