import {Op} from 'sequelize';
import Level from '@/models/levels/Level.js';
import Difficulty from '@/models/levels/Difficulty.js';
import LevelTag from '@/models/levels/LevelTag.js';
import CurationType from '@/models/curations/CurationType.js';
import {DiscordGuild} from '@/models/discord/index.js';
import {clientUrlEnv} from '@/config/app.config.js';
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
import {appendSongSuffix} from '@/misc/utils/data/levelHelpers.js';
import {
  appendRerateScoreTargetLines,
  formatRerateScoreTargetLines,
  normalizePguRequest,
  normalizePositiveIdList,
} from '@/misc/utils/data/levelRequestValidation.js';
import {excludeAutomaticTagIds, isRequestableLevelTag, loadSerializedAssignedTags} from '@/server/services/data/levelTagGroupService.js';

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

const ECHO_WEBHOOK_ENV: Record<string, string> = {
  rerate: 'RERATE_REQ_ECHO_WEBHOOK',
  info_change: 'INFO_REQ_ECHO_WEBHOOK',
  tag: 'TAG_REQ_ECHO_WEBHOOK',
};

const INFO_KIND_LABELS: Record<string, string> = {
  song: 'Song',
  artist: 'Artist',
  credits: 'Credits',
  video: 'Video',
  download: 'Download',
  description: 'Description',
  multiple: 'Multiple',
};

const CREDIT_ROLE_LABELS: Record<string, string> = {
  charter: 'Charter',
  vfxer: 'VFXer',
  specialThanks: 'Special thanks',
};

function songArtistTitle(level: Level): string {
  const songBase = String(level.song || 'Unknown Song').trim() || 'Unknown Song';
  // level.song is the joined display name, so appending suffix again repeats it.
  const song = appendSongSuffix(songBase, level.suffix) || songBase;
  const artist = String(level.artist || 'Unknown Artist').trim() || 'Unknown Artist';
  return `${song} - ${artist}`.slice(0, 256);
}

function adminRequestUrl(type: string): string {
  const hash = type === 'info_change' ? 'info' : type === 'tag' ? 'tag' : 'rerate';
  const base = String(clientUrlEnv || 'http://localhost:5173').replace(/\/$/, '');
  return `${base}/admin/requests#${hash}`;
}

function requestLinkLine(request: LevelRequest): string {
  return `[Request #${request.id}](${adminRequestUrl(request.type)})`;
}

function joinDescription(parts: Array<string | null | undefined>): string {
  return parts
    .filter((part): part is string => part != null)
    .join('\n')
    .slice(0, 4000);
}

async function difficultyMarksByName(): Promise<Map<string, string>> {
  const rows = await Difficulty.findAll({attributes: ['name', 'emoji']});
  return new Map(
    rows.map((row) => [String(row.name || '').toLowerCase(), String(row.emoji || '').trim() || row.name]),
  );
}

function ratingMark(raw: string, byName: Map<string, string>): string {
  const tokens = normalizePguRequest(raw).split(/([-~])/).filter((part) => part !== '');
  if (!tokens.length) return '';
  return tokens
    .map((token) => {
      if (token === '-' || token === '~') return token;
      return byName.get(token.toLowerCase()) || token;
    })
    .join('');
}

async function comparisonEchoLines(payload: Record<string, unknown>): Promise<string> {
  const ids = Array.isArray(payload.comparisons)
    ? payload.comparisons
      .map((row) => Number((row as {levelId?: number}).levelId))
      .filter((id) => Number.isInteger(id) && id > 0)
    : [];
  if (!ids.length) return '—';
  const levels = await Level.findAll({
    where: {id: {[Op.in]: ids}},
    attributes: ['id', 'song', 'artist', 'suffix'],
    include: [{model: Difficulty, as: 'difficulty', attributes: ['emoji'], required: false}],
  });
  const byId = new Map(levels.map((level) => [level.id, level]));
  return ids
    .map((id) => {
      const level = byId.get(id);
      if (!level) return `[#${id}](${levelUrl(id)})`;
      const emoji = String(level.difficulty?.emoji || '').trim();
      const label = `${emoji} ${songArtistTitle(level)}`.replace(/\s+/g, ' ').trim();
      return `[${label}](${levelUrl(id)})`;
    })
    .join('\n');
}

function creditEchoLines(payload: Record<string, unknown>): string[] {
  const team = payload.team && typeof payload.team === 'object' && !Array.isArray(payload.team)
    ? String((payload.team as {name?: unknown}).name || '').trim()
    : '';
  const credits = Array.isArray(payload.credits) ? payload.credits : [];
  const creditLines = credits.map((row) => {
    if (!row || typeof row !== 'object') return '';
    const credit = row as {name?: unknown; role?: unknown; isOwner?: unknown};
    const name = String(credit.name || '').trim() || 'Unknown';
    const roleKey = String(credit.role || '');
    const role = CREDIT_ROLE_LABELS[roleKey] || roleKey;
    const owner = credit.isOwner === true ? ' · owner' : '';
    return `${name} · ${role}${owner}`;
  }).filter(Boolean);
  return [
    `Team: ${team || '—'}`,
    'Credits:',
    creditLines.join('\n') || '—',
  ];
}

function infoChangeValueLines(payload: Record<string, unknown>): string[] {
  const kind = String(payload.kind || '');
  if (kind === 'song') {
    const label = appendSongSuffix(payload.songName, payload.suffix) || String(payload.songName || '').trim();
    return [`Change to: ${label || '—'}`];
  }
  if (kind === 'artist') {
    return [`Change to: ${String(payload.artistName || '').trim() || '—'}`];
  }
  if (kind === 'credits') return creditEchoLines(payload);
  if (kind === 'download') {
    const name = String(payload.originalName || '').trim();
    const value = String(payload.value || '').trim();
    if (name && value && name !== value) return [name, value];
    return [`Change to: ${name || value || '—'}`];
  }
  return [`Change to: ${String(payload.value || '').trim() || '—'}`];
}

async function tagNameLine(ids: number[]): Promise<string> {
  if (!ids.length) return '—';
  const tags = await LevelTag.findAll({
    where: {id: {[Op.in]: ids}},
    attributes: ['id', 'name'],
  });
  const byId = new Map(tags.map((tag) => [tag.id, tag.name]));
  return ids.map((id) => byId.get(id) || `#${id}`).join(', ');
}

async function currentAssignableTagIds(levelId: number): Promise<number[]> {
  const tags = await loadSerializedAssignedTags(levelId);
  return tags
    .filter((tag) => isRequestableLevelTag(tag))
    .map((tag) => Number(tag.id))
    .filter((id) => Number.isInteger(id) && id > 0);
}

async function echoDescription(request: LevelRequest, level: Level): Promise<string> {
  const payload = request.payload || {};
  const link = requestLinkLine(request);
  const reason = ['Reason:', request.reason || ''];
  if (request.type === 'rerate') {
    const byName = await difficultyMarksByName();
    const frozen = ratingMark(String(payload.frozenDiffName || ''), byName) || '—';
    const requested = ratingMark(String(payload.requestedRating || ''), byName) || '—';
    return joinDescription([
      link,
      `Current: ${frozen}`,
      `Requested: ${requested}`,
      ...formatRerateScoreTargetLines(payload),
      '',
      'Comparisons:',
      await comparisonEchoLines(payload),
      ...reason,
    ]);
  }
  if (request.type === 'info_change') {
    const kind = String(payload.kind || '');
    return joinDescription([
      link,
      `Kind: ${INFO_KIND_LABELS[kind] || kind || '—'}`,
      ...infoChangeValueLines(payload),
      ...reason,
    ]);
  }
  const targetIds = await excludeAutomaticTagIds(normalizePositiveIdList(payload.targetTagIds));
  const currentIds = await currentAssignableTagIds(level.id);
  const currentSet = new Set(currentIds);
  const targetSet = new Set(targetIds);
  return joinDescription([
    link,
    'Add:',
    await tagNameLine(targetIds.filter((id) => !currentSet.has(id))),
    'Remove:',
    await tagNameLine(currentIds.filter((id) => !targetSet.has(id))),
    ...reason,
  ]);
}

/** Staff-channel copy of a new rerate, info-change, or tag request. Never stores a Discord URL. */
export async function echoNewLevelRequest(request: LevelRequest, level: Level): Promise<void> {
  const envName = ECHO_WEBHOOK_ENV[request.type];
  if (!envName) return;
  const webhookUrl = (process.env[envName] || '').trim();
  if (!webhookUrl) {
    logger.warn('[level-request] Echo webhook is not configured', {
      requestId: request.id,
      type: request.type,
      envName,
    });
    return;
  }
  try {
    const mention = await createdByLine(request.requesterUserId, 'TUF user');
    await executeWebhook(
      webhookUrl,
      {
        content: mention.content,
        allowed_mentions: mention.allowed_mentions,
        embeds: [
          {
            title: songArtistTitle(level),
            url: levelUrl(level.id),
            description: await echoDescription(request, level),
          },
        ],
      },
      {wait: 'true'},
    );
  } catch (error) {
    logger.warn('[level-request] Echo webhook failed', {
      requestId: request.id,
      type: request.type,
      message: error instanceof Error ? error.message : String(error),
    });
  }
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
