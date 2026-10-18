import {Op} from 'sequelize';
import Difficulty from '@/models/levels/Difficulty.js';
import Level from '@/models/levels/Level.js';
import LevelCredit from '@/models/levels/LevelCredit.js';
import Creator from '@/models/credits/Creator.js';
import Team from '@/models/credits/Team.js';
import OAuthProvider from '@/models/auth/OAuthProvider.js';
import User from '@/models/auth/User.js';
import CurationType from '@/models/curations/CurationType.js';
import {DiscordGuild} from '@/models/discord/index.js';
import {clientUrlEnv} from '@/config/app.config.js';
import {logger} from '@/server/services/core/LoggerService.js';
import type LevelRequest from '@/models/levels/LevelRequest.js';
import {normalizePguRequest} from '@/misc/utils/data/levelRequestValidation.js';

type WebhookMessage = {
  id?: string;
  channel_id?: string;
};

function levelUrl(levelId: number): string {
  const base = String(clientUrlEnv || 'http://localhost:5173').replace(/\/$/, '');
  return `${base}/levels/${levelId}`;
}

async function executeWebhook(
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

async function activeGuildId(): Promise<string | null> {
  const guild = await DiscordGuild.findOne({
    where: {isActive: true},
    attributes: ['guildId'],
    order: [['id', 'ASC']],
  });
  return guild?.guildId ?? null;
}

function jumpUrl(guildId: string | null, message: WebhookMessage): string | null {
  if (!guildId || !message.channel_id || !message.id) return null;
  return `https://discord.com/channels/${guildId}/${message.channel_id}/${message.id}`;
}

async function createdByLine(
  userId: string,
  fallback = 'TUF staff',
): Promise<{content: string; allowed_mentions: {parse: string[]; users: string[]}}> {
  const [user, discord] = await Promise.all([
    User.findByPk(userId, {attributes: ['id', 'username', 'nickname']}),
    OAuthProvider.findOne({where: {userId, provider: 'discord'}, attributes: ['providerId']}),
  ]);
  const websiteUsername = user?.username?.trim() || '';
  const bracket = websiteUsername
    ? `(@${websiteUsername})`
    : `(${user?.nickname?.trim() || fallback})`;
  if (discord?.providerId) {
    return {
      content: `created by <@${discord.providerId}> ${bracket}`,
      allowed_mentions: {parse: [], users: [discord.providerId]},
    };
  }
  return {
    content: `created by ${bracket}`,
    allowed_mentions: {parse: [], users: []},
  };
}

const announcerAvatar = process.env.BOT_AVATAR_URL
  || 'https://soggy.cat/static/ssoggycat/main/images/soggycat.webp';

function creatorLabel(level: Level | null | undefined): string {
  if (!level) return '';
  if (level.team) return level.team;
  const names = (level.levelCredits || [])
    .filter((credit) => String(credit.role).toLowerCase() === 'charter')
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id)
    .map((credit) => credit.creator?.name)
    .filter((name): name is string => Boolean(name));
  if (!names.length) return '';
  if (names.length === 1) return names[0];
  return `${names[0]} & ${names.length - 1} more`;
}

function withCreator(song: string, creator: string): string {
  return creator ? `${song} (${creator})` : song;
}

function songArtistTitle(level: Level): string {
  const songBase = String(level.song || 'Unknown Song').trim() || 'Unknown Song';
  const song = level.suffix ? `${songBase} ${level.suffix}` : songBase;
  const artist = String(level.artist || 'Unknown Artist').trim() || 'Unknown Artist';
  return `${song} - ${artist}`.slice(0, 256);
}

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

async function loadChart(levelId: number): Promise<Level | null> {
  return Level.findByPk(levelId, {
    attributes: ['id', 'song', 'diffId', 'teamId'],
    include: [
      {model: Difficulty, as: 'difficulty', attributes: ['id', 'name', 'emoji'], required: false},
      {model: Team, as: 'teamObject', attributes: ['id', 'name'], required: false},
      {
        model: LevelCredit,
        as: 'levelCredits',
        attributes: ['id', 'role', 'sortOrder'],
        required: false,
        include: [{model: Creator, as: 'creator', attributes: ['id', 'name'], required: false}],
      },
    ],
  });
}

async function difficultyMark(diffId: number | null | undefined): Promise<{name: string; emoji: string}> {
  if (diffId == null) return {name: '', emoji: ''};
  const row = await Difficulty.findByPk(diffId, {attributes: ['name', 'emoji']});
  return {name: row?.name || '', emoji: row?.emoji || ''};
}

async function requestedDifficultyMarks(requested: string): Promise<{names: string; emojis: string}> {
  const tokens = normalizePguRequest(requested).split(/([-~])/).filter((part) => part !== '');
  const rows = await Difficulty.findAll({attributes: ['name', 'emoji']});
  const byName = new Map(rows.map((row) => [row.name.toLowerCase(), row]));
  const names: string[] = [];
  const emojis: string[] = [];
  for (const token of tokens) {
    if (token === '-' || token === '~') {
      names.push(token);
      emojis.push(token);
      continue;
    }
    const row = byName.get(token.toLowerCase());
    const name = row?.name || token;
    names.push(name);
    emojis.push(row?.emoji || name);
  }
  return {names: names.join(''), emojis: emojis.join('')};
}

function webhookEnvFor(type: string): string {
  if (type === 'curation_rerate') return 'CURATION_RERATE_WEBHOOK';
  if (type === 'curation') return 'CURATION_REQUEST_WEBHOOK';
  return 'RERATE_REQUEST_WEBHOOK';
}

export function discordJumpTarget(url: string): {threadId: string; messageId: string} | null {
  const match = String(url || '').match(/discord(?:app)?\.com\/channels\/\d+\/(\d+)\/(\d+)/i);
  if (!match) return null;
  return {threadId: match[1], messageId: match[2]};
}

async function deleteWebhookMessage(webhookUrl: string, messageId: string, threadId: string | null): Promise<void> {
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

async function discordBotToken(): Promise<string> {
  const guild = await DiscordGuild.findOne({
    where: {isActive: true},
    order: [['id', 'ASC']],
  });
  return guild?.getDataValue('botToken') || process.env.DISCORD_BOT_TOKEN || '';
}

async function patchThread(threadId: string, token: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`https://discord.com/api/v10/channels/${threadId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bot ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

/** Archive and lock a rerate forum thread so the discussion stays readable. */
async function closeForumThread(threadId: string): Promise<'closed' | 'missing'> {
  const token = await discordBotToken();
  if (!token) throw new Error('Discord bot token is not configured');
  let response = await patchThread(threadId, token, {archived: true, locked: true});
  if (response.status === 404) {
    await response.text();
    return 'missing';
  }
  if (response.status === 400) {
    await response.text();
    response = await patchThread(threadId, token, {archived: true});
  }
  const text = await response.text();
  if (response.status === 404) return 'missing';
  if (!response.ok) {
    throw new Error(`Discord ${response.status}: ${text.slice(0, 300)}`);
  }
  return 'closed';
}

/** Rerate discussion threads are closed. Other Discord posts are deleted. */
export async function deleteLevelRequestDiscordPost(request: LevelRequest): Promise<'closed' | 'removed'> {
  const jump = discordJumpTarget(request.discordMessageUrl || '');
  if (!jump) {
    throw new Error('Stored Discord post URL is not a channel message link');
  }
  if (request.type === 'rerate') {
    const outcome = await closeForumThread(jump.threadId);
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

export async function postRerateRequestThread(
  request: LevelRequest,
  level: Level,
  actorUserId: string,
): Promise<{url: string | null}> {
  const webhookUrl = (process.env.RERATE_REQUEST_WEBHOOK || '').trim();
  if (!webhookUrl) {
    throw new Error('RERATE_REQUEST_WEBHOOK is not configured');
  }
  const payload = request.payload || {};
  const chart = await loadChart(level.id);
  const current = chart?.difficulty?.name
    ? {name: chart.difficulty.name || '', emoji: chart.difficulty.emoji || ''}
    : await difficultyMark(chart?.diffId ?? level.diffId);
  const requested = await requestedDifficultyMarks(String(payload.requestedRating || ''));
  const song = chart?.song || level.song || 'Unknown';
  const creator = creatorLabel(chart);
  const titled = (mark: string) => `${mark} ${withCreator(song, creator)} ➔ ${requested.names || requested.emojis}`
    .replace(/\s+/g, ' ')
    .trim();
  const threadName = titled(current.name || current.emoji).slice(0, 100);
  const emojiLine = `${current.emoji || current.name} ${withCreator(song, creator)} ➔ ${requested.emojis || requested.names}`
    .replace(/\s+/g, ' ')
    .trim();
  const comparisonIds = Array.isArray(payload.comparisons)
    ? payload.comparisons.map((row) => Number((row as {levelId?: number}).levelId)).filter((id) => id > 0)
    : [];
  const comparisonLines = (await Promise.all(comparisonIds.map(async (levelId) => {
    const row = await loadChart(levelId);
    if (!row) return null;
    const emoji = row.difficulty?.emoji || '';
    const label = `${emoji} ${withCreator(row.song || `#${levelId}`, creatorLabel(row))}`.replace(/\s+/g, ' ').trim();
    return `[${label}](${levelUrl(levelId)})`;
  }))).filter((line): line is string => Boolean(line));
  const description = [
    'Reason:',
    request.reason || '',
    '',
    'Comparisons:',
    comparisonLines.join('\n') || '—',
  ].join('\n').slice(0, 4000);
  const mention = await createdByLine(actorUserId);
  const message = await executeWebhook(
    webhookUrl,
    {
      username: 'Rerate request',
      avatar_url: announcerAvatar,
      content: `${emojiLine}\n${mention.content}`.slice(0, 2000),
      allowed_mentions: mention.allowed_mentions,
      thread_name: threadName,
      embeds: [
        {
          title: `Request #${request.id}`,
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

export function logRequestDiscordFailure(requestId: number, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  logger.warn('[level-request] Discord post failed', {requestId, message});
  return message.slice(0, 500);
}
