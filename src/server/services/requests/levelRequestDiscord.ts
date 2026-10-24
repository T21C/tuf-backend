import {Op} from 'sequelize';
import Level from '@/models/levels/Level.js';
import CurationType from '@/models/curations/CurationType.js';
import {DiscordGuild} from '@/models/discord/index.js';
import {logger} from '@/server/services/core/LoggerService.js';
import type LevelRequest from '@/models/levels/LevelRequest.js';
import {
  activeGuildId,
  deleteWebhookMessage,
  discordJumpTarget,
  executeWebhook,
  jumpUrl,
  levelUrl,
  logRatingThreadFailure,
} from '@/server/services/discord/discordWebhook.js';
import {
  closeRatingThread,
  createdByLine,
  createRatingThread,
  reopenRatingThread,
} from '@/server/services/discord/ratingThread.js';
import {appendRerateScoreTargetLines} from '@/misc/utils/data/levelRequestValidation.js';

export {discordJumpTarget, logRatingThreadFailure as logRequestDiscordFailure};

type GuildEmojiRow = {id?: string; name?: string; animated?: boolean};

let guildEmojiCache: {at: number; byName: Map<string, string>} | null = null;
const GUILD_EMOJI_TTL_MS = 10 * 60 * 1000;

async function guildEmojiMarkupByName(): Promise<Map<string, string>> {
  const now = Date.now();
  if (guildEmojiCache && now - guildEmojiCache.at < GUILD_EMOJI_TTL_MS) {
    return guildEmojiCache.byName;
  }
  const guild = await DiscordGuild.findOne({
    where: {isActive: true},
    order: [['id', 'ASC']],
  });
  const guildId = guild?.guildId;
  const token = guild?.getDataValue('botToken') || process.env.DISCORD_BOT_TOKEN || '';
  if (!guildId || !token) {
    return guildEmojiCache?.byName ?? new Map();
  }
  try {
    const response = await fetch(`https://discord.com/api/v10/guilds/${guildId}/emojis`, {
      headers: {Authorization: `Bot ${token}`},
    });
    if (!response.ok) {
      logger.warn('[level-request] Guild emoji lookup failed', {status: response.status});
      return guildEmojiCache?.byName ?? new Map();
    }
    const rows = (await response.json()) as GuildEmojiRow[];
    const byName = new Map<string, string>();
    for (const row of rows) {
      if (!row?.id || !row?.name) continue;
      const markup = row.animated ? `<a:${row.name}:${row.id}>` : `<:${row.name}:${row.id}>`;
      byName.set(row.name.toLowerCase(), markup);
    }
    guildEmojiCache = {at: now, byName};
    return byName;
  } catch (error) {
    logger.warn('[level-request] Guild emoji lookup failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    return guildEmojiCache?.byName ?? new Map();
  }
}

async function requestedCurationEmojis(typeIds: unknown): Promise<string> {
  const ids = Array.isArray(typeIds)
    ? [...new Set(typeIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))]
    : [];
  if (!ids.length) return '';
  const types = await CurationType.findAll({
    where: {id: {[Op.in]: ids}},
    attributes: ['id', 'name'],
  });
  const byId = new Map(types.map((type) => [type.id, type]));
  const emojis = await guildEmojiMarkupByName();
  return ids
    .map((id) => {
      const type = byId.get(id);
      if (!type) return '';
      const key = String(type.name || '').toLowerCase();
      return emojis.get(key) || type.name || `#${id}`;
    })
    .filter(Boolean)
    .join(' ');
}

function songArtistTitle(level: Level): string {
  const songBase = String(level.song || 'Unknown Song').trim() || 'Unknown Song';
  const song = level.suffix ? `${songBase} ${level.suffix}` : songBase;
  const artist = String(level.artist || 'Unknown Artist').trim() || 'Unknown Artist';
  return `${song} - ${artist}`.slice(0, 256);
}

function webhookEnvFor(type: string): string {
  if (type === 'curation_rerate') return 'CURATION_RERATE_WEBHOOK';
  if (type === 'curation') return 'CURATION_REQUEST_WEBHOOK';
  return 'RERATE_REQUEST_WEBHOOK';
}

/** Rerate threads go through the shared rating-thread module. Other posts are deleted. */
export async function deleteLevelRequestDiscordPost(
  request: LevelRequest,
  options: {actorUserId?: string; ping?: boolean} = {},
): Promise<'closed' | 'removed'> {
  const jump = discordJumpTarget(request.discordMessageUrl || '');
  if (!jump) {
    throw new Error('Stored Discord post URL is not a channel message link');
  }
  if (request.type === 'rerate') {
    if (!options.actorUserId) throw new Error('Closing a rating thread requires the acting user');
    const outcome = await closeRatingThread({
      threadUrl: request.discordMessageUrl || '',
      actorUserId: options.actorUserId,
      ping: options.ping === true,
    });
    return outcome === 'missing' ? 'removed' : 'closed';
  }
  const envName = webhookEnvFor(request.type);
  const webhookUrl = (process.env[envName] || '').trim();
  if (!webhookUrl) {
    throw new Error(`${envName} is not configured`);
  }
  await deleteWebhookMessage(webhookUrl, jump.messageId, null);
  return 'removed';
}

export async function reopenLevelRequestDiscordThread(
  request: LevelRequest,
  options: {actorUserId: string; ping?: boolean},
): Promise<'reopened' | 'missing'> {
  return reopenRatingThread({
    threadUrl: request.discordMessageUrl || '',
    actorUserId: options.actorUserId,
    ping: options.ping === true,
  });
}

export async function postRerateRequestThread(
  request: LevelRequest,
  level: Level,
  actorUserId: string,
  ping = false,
): Promise<{url: string | null}> {
  const payload = request.payload || {};
  const comparisonLevelIds = Array.isArray(payload.comparisons)
    ? payload.comparisons.map((row) => Number((row as {levelId?: number}).levelId)).filter((id) => id > 0)
    : [];
  return createRatingThread({
    levelId: level.id,
    requestedRating: String(payload.requestedRating || ''),
    reason: appendRerateScoreTargetLines(request.reason || '', payload),
    comparisonLevelIds,
    actorUserId,
    embedTitle: `Request #${request.id}`,
    ping,
  });
}

export async function postCurationRequestEmbed(request: LevelRequest, level: Level): Promise<{url: string | null}> {
  const envName = request.type === 'curation_rerate' ? 'CURATION_RERATE_WEBHOOK' : 'CURATION_REQUEST_WEBHOOK';
  const webhookUrl = (process.env[envName] || '').trim();
  if (!webhookUrl) {
    throw new Error(`${envName} is not configured`);
  }
  const addIds = request.payload?.addCurationTypeIds;
  const removeIds = request.payload?.removeCurationTypeIds;
  const hasDiff = request.type === 'curation_rerate' && (Array.isArray(addIds) || Array.isArray(removeIds));
  const mention = await createdByLine(request.requesterUserId, 'TUF user');
  const description = hasDiff
    ? [
        'Add:',
        (await requestedCurationEmojis(addIds)) || '—',
        'Remove:',
        (await requestedCurationEmojis(removeIds)) || '—',
        'Reason:',
        request.reason || '',
      ].join('\n').slice(0, 4000)
    : [
        'Requested curations:',
        await requestedCurationEmojis(request.payload?.curationTypeIds),
        'Reason:',
        request.reason || '',
      ].join('\n').slice(0, 4000);
  const message = await executeWebhook(
    webhookUrl,
    {
      content: mention.content,
      allowed_mentions: mention.allowed_mentions,
      embeds: [
        {
          title: songArtistTitle(level),
          url: levelUrl(level.id),
          description,
        },
      ],
    },
    {wait: 'true'},
  );
  const guildId = await activeGuildId();
  return {url: jumpUrl(guildId, message)};
}
