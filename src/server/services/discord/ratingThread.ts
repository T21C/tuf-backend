import {Op, type Transaction} from 'sequelize';
import Difficulty from '@/models/levels/Difficulty.js';
import Level from '@/models/levels/Level.js';
import LevelCredit from '@/models/levels/LevelCredit.js';
import Creator from '@/models/credits/Creator.js';
import Team from '@/models/credits/Team.js';
import OAuthProvider from '@/models/auth/OAuthProvider.js';
import User from '@/models/auth/User.js';
import Rating from '@/models/levels/Rating.js';
import Pass from '@/models/passes/Pass.js';
import {normalizePguRequest} from '@/misc/utils/data/levelRequestValidation.js';
import {logger} from '@/server/services/core/LoggerService.js';
import {
  voteThreadLabel,
  websiteRatingLabel,
} from '@/misc/utils/data/ratingThread.js';
import {
  activeGuildId,
  discordBotToken,
  discordJumpTarget,
  executeWebhook,
  jumpUrl,
  levelUrl,
  patchThread,
  webhookMissing,
} from '@/server/services/discord/discordWebhook.js';

export {
  discordJumpTarget,
  logRatingThreadFailure,
} from '@/server/services/discord/discordWebhook.js';
export {
  readRatingThreadRequest,
  ratingThreadWantsPing,
  voteThreadLabel,
  websiteRatingLabel,
} from '@/misc/utils/data/ratingThread.js';
export type {RatingThreadLifecycle} from '@/misc/utils/data/ratingThread.js';

/**
 * Discord forum threads for rating votes.
 *
 * Call this module for the whole lifecycle. Do not post, archive, or phrase
 * these messages anywhere else.
 *
 * createRatingThread — opening post. `ping` defaults off.
 * closeRatingThread — "Thread closed by <@user> (@user)", then archive and lock.
 * reopenRatingThread — unlock and unarchive, then "Thread reopened by <@user> (@user)".
 * applyRatingThreadMode — `discord` prefixes the rating-page label with "vote";
 *   `website` removes it so the chart is rated on the site again.
 */

const RATING_THREAD_ROLE_ENVS = ['RATING_ADVISOR_ROLE_ID', 'UNIVERSAL_RATER_ROLE_ID'] as const;

const announcerAvatar = process.env.BOT_AVATAR_URL
  || 'https://soggy.cat/static/ssoggycat/main/images/soggycat.webp';

function ratingTeamRoleIds(): string[] {
  const ids: string[] = [];
  for (const name of RATING_THREAD_ROLE_ENVS) {
    const id = String(process.env[name] || '').trim();
    if (!id) {
      logger.warn('[rating-thread] Role mention skipped; env is unset', {name});
      continue;
    }
    if (!/^\d{17,20}$/.test(id)) {
      logger.warn('[rating-thread] Role mention skipped; env is not a role id', {name});
      continue;
    }
    ids.push(id);
  }
  return ids;
}

function ratingTeamPing(enabled: boolean): {text: string; roleIds: string[]} {
  if (!enabled) return {text: '', roleIds: []};
  const roleIds = ratingTeamRoleIds();
  return {text: roleIds.map((id) => `<@&${id}>`).join(' '), roleIds};
}

async function actorCredit(userId: string, fallback = 'TUF staff'): Promise<{who: string; userIds: string[]}> {
  const [user, discord] = await Promise.all([
    User.findByPk(userId, {attributes: ['id', 'username', 'nickname']}),
    OAuthProvider.findOne({where: {userId, provider: 'discord'}, attributes: ['providerId']}),
  ]);
  const websiteUsername = user?.username?.trim() || '';
  const bracket = websiteUsername
    ? `(@${websiteUsername})`
    : `(${user?.nickname?.trim() || fallback})`;
  if (discord?.providerId) {
    return {who: `<@${discord.providerId}> ${bracket}`, userIds: [discord.providerId]};
  }
  return {who: bracket, userIds: []};
}

export async function createdByLine(
  userId: string,
  fallback = 'TUF staff',
): Promise<{content: string; allowed_mentions: {parse: string[]; users: string[]}}> {
  const actor = await actorCredit(userId, fallback);
  return {
    content: `created by ${actor.who}`,
    allowed_mentions: {parse: [], users: actor.userIds},
  };
}

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

async function topScoreClearVideoUrl(levelId: number): Promise<string> {
  const pass = await Pass.findOne({
    where: {
      levelId,
      isDeleted: false,
      isHidden: false,
      videoLink: {[Op.and]: [{[Op.ne]: null}, {[Op.ne]: ''}]},
    },
    order: [['scoreV2', 'DESC'], ['id', 'DESC']],
    attributes: ['videoLink'],
  });
  return typeof pass?.videoLink === 'string' ? pass.videoLink.trim() : '';
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

function rerateWebhookUrl(): string {
  const webhookUrl = (process.env.RERATE_REQUEST_WEBHOOK || '').trim();
  if (!webhookUrl) throw new Error('RERATE_REQUEST_WEBHOOK is not configured');
  return webhookUrl;
}

async function postThreadNotice(
  threadId: string,
  actorUserId: string,
  action: 'closed' | 'reopened',
  ping: boolean,
): Promise<void> {
  const actor = await actorCredit(actorUserId);
  const team = ratingTeamPing(ping);
  await executeWebhook(
    rerateWebhookUrl(),
    {
      username: 'Rerate request',
      avatar_url: announcerAvatar,
      content: [team.text, `Thread ${action} by ${actor.who}`].filter(Boolean).join('\n').slice(0, 2000),
      allowed_mentions: {parse: [], users: actor.userIds, roles: team.roleIds},
    },
    {thread_id: threadId, wait: 'true'},
  );
}

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
  if (!response.ok) throw new Error(`Discord ${response.status}: ${text.slice(0, 300)}`);
  return 'closed';
}

async function reopenForumThread(threadId: string): Promise<'reopened' | 'missing'> {
  const token = await discordBotToken();
  if (!token) throw new Error('Discord bot token is not configured');
  let response = await patchThread(threadId, token, {archived: false, locked: false});
  if (response.status === 404) {
    await response.text();
    return 'missing';
  }
  if (response.status === 400) {
    await response.text();
    response = await patchThread(threadId, token, {archived: false});
    if (response.ok) {
      const unlock = await patchThread(threadId, token, {locked: false});
      await unlock.text();
      return 'reopened';
    }
  }
  const text = await response.text();
  if (response.status === 404) return 'missing';
  if (!response.ok) throw new Error(`Discord ${response.status}: ${text.slice(0, 300)}`);
  return 'reopened';
}

export async function createRatingThread(input: {
  levelId: number;
  requestedRating: string;
  reason: string;
  comparisonLevelIds: number[];
  actorUserId: string;
  embedTitle?: string;
  /** Mention the rating team. Defaults to false. */
  ping?: boolean;
}): Promise<{url: string | null}> {
  const chart = await loadChart(input.levelId);
  const current = chart?.difficulty?.name
    ? {name: chart.difficulty.name || '', emoji: chart.difficulty.emoji || ''}
    : await difficultyMark(chart?.diffId);
  const requested = await requestedDifficultyMarks(input.requestedRating);
  const song = chart?.song || 'Unknown';
  const creator = creatorLabel(chart);
  const titled = (mark: string) => `${mark} ${withCreator(song, creator)} ➔ ${requested.names || requested.emojis}`
    .replace(/\s+/g, ' ')
    .trim();
  const threadName = titled(current.name || current.emoji).slice(0, 100);
  const emojiLine = `${current.emoji || current.name} ${withCreator(song, creator)} ➔ ${requested.emojis || requested.names}`
    .replace(/\s+/g, ' ')
    .trim();
  const comparisonLines = (await Promise.all(input.comparisonLevelIds.map(async (levelId) => {
    const row = await loadChart(levelId);
    if (!row) return null;
    const emoji = row.difficulty?.emoji || '';
    const label = `${emoji} ${withCreator(row.song || `#${levelId}`, creatorLabel(row))}`.replace(/\s+/g, ' ').trim();
    return `[${label}](${levelUrl(levelId)})`;
  }))).filter((line): line is string => Boolean(line));
  const description = [
    'Reason:',
    input.reason || '',
    '',
    'Comparisons:',
    comparisonLines.join('\n') || '—',
  ].join('\n').slice(0, 4000);
  const mention = await createdByLine(input.actorUserId);
  const team = ratingTeamPing(input.ping === true);
  const videoUrl = await topScoreClearVideoUrl(input.levelId);
  const message = await executeWebhook(
    rerateWebhookUrl(),
    {
      username: 'Rerate request',
      avatar_url: announcerAvatar,
      content: [team.text, emojiLine, mention.content, videoUrl].filter(Boolean).join('\n').slice(0, 2000),
      allowed_mentions: {
        parse: [],
        users: mention.allowed_mentions.users,
        roles: team.roleIds,
      },
      thread_name: threadName,
      embeds: [
        {
          title: input.embedTitle || song,
          url: levelUrl(input.levelId),
          description,
        },
      ],
    },
    {wait: 'true'},
  );
  const guildId = await activeGuildId();
  return {url: jumpUrl(guildId, message)};
}

/** Post the closed line while the thread can still receive it, then archive and lock. */
export async function closeRatingThread(input: {
  threadUrl: string;
  actorUserId: string;
  ping?: boolean;
}): Promise<'closed' | 'missing'> {
  const jump = discordJumpTarget(input.threadUrl);
  if (!jump) throw new Error('Stored Discord post URL is not a channel message link');
  try {
    await postThreadNotice(jump.threadId, input.actorUserId, 'closed', input.ping === true);
  } catch (error) {
    if (webhookMissing(error)) return 'missing';
    throw error;
  }
  return closeForumThread(jump.threadId);
}

/** Unlock the same thread, then post the reopened line. */
export async function reopenRatingThread(input: {
  threadUrl: string;
  actorUserId: string;
  ping?: boolean;
}): Promise<'reopened' | 'missing'> {
  const jump = discordJumpTarget(input.threadUrl);
  if (!jump) throw new Error('Stored Discord post URL is not a channel message link');
  const outcome = await reopenForumThread(jump.threadId);
  if (outcome === 'missing') return 'missing';
  try {
    await postThreadNotice(jump.threadId, input.actorUserId, 'reopened', input.ping === true);
  } catch (error) {
    if (webhookMissing(error)) return 'missing';
    throw error;
  }
  return 'reopened';
}

/** Switch the open rating between a Discord vote label and a website rating label. */
export async function applyRatingThreadMode(
  level: Level,
  rating: Rating | null | undefined,
  mode: 'discord' | 'website',
  transaction?: Transaction,
): Promise<{rerateNum: string; requesterFR: string}> {
  if (mode === 'discord') {
    const labeled = voteThreadLabel(level.rerateNum || rating?.requesterFR || '');
    await level.update({rerateNum: labeled}, {transaction});
    if (rating) await rating.update({requesterFR: labeled}, {transaction});
    return {rerateNum: labeled, requesterFR: labeled};
  }
  const rerateNum = websiteRatingLabel(level.rerateNum || rating?.requesterFR || '');
  const requesterFR = websiteRatingLabel(rating?.requesterFR || level.rerateNum || '');
  await level.update({rerateNum}, {transaction});
  if (rating) await rating.update({requesterFR}, {transaction});
  return {rerateNum, requesterFR};
}
