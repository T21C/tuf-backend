import {Webhook, MessageBuilder} from '@/misc/webhook/index.js';
import {clientUrlEnv} from '@/config/app.config.js';
import {logger} from '@/server/services/core/LoggerService.js';
import {type ModReportBody} from './modReportParse.js';

export type {ModReportBody, ModReportReason} from './modReportParse.js';
export {parseModReportBody, REPORT_NOTE_MAX, REPORT_REASONS} from './modReportParse.js';

const DISCORD_FIELD_MAX = 1024;

const REPORT_EMBED_COLOR = {
  abuse: 0xbb2222,
  duplicate: 0x28a745,
  deprecated: 0xffc107,
} as const;

function clipField(value: string): string {
  if (value.length <= DISCORD_FIELD_MAX) return value;
  return `${value.slice(0, DISCORD_FIELD_MAX - 1)}…`;
}

export async function sendModReport(options: {
  mod: {name: string; slug: string; imageUrl?: string | null};
  reporter: {
    id: string;
    name: string;
    avatarUrl?: string | null;
    playerId?: number | null;
  };
  report: ModReportBody;
}): Promise<void> {
  const webhookUrl = (process.env.MOD_REPORT_WEBHOOK_URL || '').trim();
  if (!webhookUrl) {
    logger.warn('MOD_REPORT_WEBHOOK_URL is not set; cannot deliver mod report');
    const err = new Error('Report webhook is not configured');
    (err as Error & {status?: number}).status = 503;
    throw err;
  }

  const siteUrl = String(clientUrlEnv || '').replace(/\/$/, '');
  const modPath = `/mods/${encodeURIComponent(options.mod.slug)}`;
  const modUrl = siteUrl ? `${siteUrl}${modPath}` : modPath;
  const profilePath = options.reporter.playerId
    ? `/profile/${options.reporter.playerId}`
    : `/profile/${options.reporter.id}`;
  const profileUrl = siteUrl ? `${siteUrl}${profilePath}` : profilePath;

  const botAvatar = process.env.BOT_AVATAR_URL || '';
  const hook = new Webhook({url: webhookUrl, throwErrors: true});
  hook.setUsername('Mod catalog report');
  if (botAvatar) hook.setAvatar(botAvatar);

  const embed = new MessageBuilder()
    .setAuthor(options.reporter.name, options.reporter.avatarUrl || '', profileUrl)
    .setTitle(options.mod.name)
    .setURL(modUrl)
    .setColor(REPORT_EMBED_COLOR[options.report.reason])
    .setTimestamp();

  if (options.mod.imageUrl) embed.setThumbnail(options.mod.imageUrl);

  if (options.report.reason === 'deprecated') {
    embed.addField('Reason', 'Deprecated', true);
    embed.addField('Version', clipField(options.report.version), true);
    embed.addField('What happens on broken version', clipField(options.report.brokenEffect), false);
  } else if (options.report.reason === 'abuse') {
    embed.addField('Reason', 'Abuse', true);
    embed.addField('Details', clipField(options.report.note), false);
  } else {
    embed.addField('Reason', 'Duplicate', true);
    embed.addField('Main mod', clipField(options.report.targetUrl), false);
    embed.addField('Why merge', clipField(options.report.mergeWhy), false);
  }

  await hook.send(embed);
}
