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

async function requesterMention(userId: string): Promise<{content: string; allowed_mentions: {parse: string[]; users: string[]}}> {
  const [user, discord] = await Promise.all([
    User.findByPk(userId, {attributes: ['id', 'username', 'nickname']}),
    OAuthProvider.findOne({where: {userId, provider: 'discord'}, attributes: ['providerId']}),
  ]);
  const name = user?.nickname || user?.username || 'TUF user';
  if (discord?.providerId) {
    return {
      content: `created by <@${discord.providerId}>`,
      allowed_mentions: {parse: [], users: [discord.providerId]},
    };
  }
  return {
    content: `created by ${name}`,
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

async function emojiForDiffId(diffId: number | null | undefined): Promise<string> {
  if (diffId == null) return '';
  const row = await Difficulty.findByPk(diffId, {attributes: ['emoji']});
  return row?.emoji || '';
}

async function requestedEmoji(requested: string): Promise<string> {
  const normalized = normalizePguRequest(requested);
  const parts = normalized.split(/[-~]/).map((part) => part.trim()).filter(Boolean);
  const rows = await Difficulty.findAll({attributes: ['name', 'emoji']});
  const byName = new Map(rows.map((row) => [row.name.toLowerCase(), row.emoji || '']));
  return parts.map((part) => byName.get(part.toLowerCase()) || part).filter(Boolean).join(' ');
}

export async function postRerateRequestThread(request: LevelRequest, level: Level): Promise<{url: string | null}> {
  const webhookUrl = (process.env.RERATE_REQUEST_WEBHOOK || '').trim();
  if (!webhookUrl) {
    throw new Error('RERATE_REQUEST_WEBHOOK is not configured');
  }
  const payload = request.payload || {};
  const chart = await loadChart(level.id);
  const currentEmoji = chart?.difficulty?.emoji || await emojiForDiffId(chart?.diffId ?? level.diffId);
  const requested = await requestedEmoji(String(payload.requestedRating || ''));
  const song = chart?.song || level.song || 'Unknown';
  const creator = creatorLabel(chart);
  const threadName = `${currentEmoji} ${withCreator(song, creator)} ➔ ${requested}`.replace(/\s+/g, ' ').trim().slice(0, 100);
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
  const mention = await requesterMention(request.requesterUserId);
  const message = await executeWebhook(
    webhookUrl,
    {
      username: 'Rerate request',
      avatar_url: announcerAvatar,
      content: mention.content,
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
  const emojis = await requestedCurationEmojis(request.payload?.curationTypeIds);
  const mention = await requesterMention(request.requesterUserId);
  const description = [
    'Requested curations:',
    emojis,
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
