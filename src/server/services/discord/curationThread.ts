import {Op} from 'sequelize';
import Creator from '@/models/credits/Creator.js';
import Team from '@/models/credits/Team.js';
import Level from '@/models/levels/Level.js';
import LevelCredit from '@/models/levels/LevelCredit.js';
import Pass from '@/models/passes/Pass.js';
import User from '@/models/auth/User.js';
import OAuthProvider from '@/models/auth/OAuthProvider.js';
import {logger} from '@/server/services/core/LoggerService.js';
import {
  activeGuildId,
  discordBotToken,
  discordJumpTarget,
  executeWebhook,
  jumpUrl,
  levelUrl,
  webhookMissing,
} from '@/server/services/discord/discordWebhook.js';
import {createdByLine} from '@/server/services/discord/ratingThread.js';

const ROLE_ENVS = ['CURATION_TEAM_ROLE_ID', 'CURATION_ADVISOR_ROLE_ID'] as const;

const announcerAvatar = process.env.BOT_AVATAR_URL
  || 'https://soggy.cat/static/ssoggycat/main/images/soggycat.webp';

function discussionWebhookUrl(): string {
  const webhookUrl = (process.env.CURATION_DISCUSSION_WEBHOOK || '').trim();
  if (!webhookUrl) throw new Error('CURATION_DISCUSSION_WEBHOOK is not configured');
  return webhookUrl;
}

function teamRoleIds(): string[] {
  const ids: string[] = [];
  for (const name of ROLE_ENVS) {
    const id = String(process.env[name] || '').trim();
    if (!id) {
      logger.warn('[curation-thread] Role mention skipped; env is unset', {name});
      continue;
    }
    if (!/^\d{17,20}$/.test(id)) {
      logger.warn('[curation-thread] Role mention skipped; env is not a role id', {name});
      continue;
    }
    ids.push(id);
  }
  return ids;
}

function teamPing(enabled: boolean): {text: string; roleIds: string[]} {
  if (!enabled) return {text: '', roleIds: []};
  const roleIds = teamRoleIds();
  return {text: roleIds.map((id) => `<@&${id}>`).join(' '), roleIds};
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

async function loadChart(levelId: number): Promise<Level | null> {
  return Level.findByPk(levelId, {
    attributes: ['id', 'song', 'teamId'],
    include: [
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

async function postThreadNotice(
  threadId: string,
  actorUserId: string,
  action: 'closed' | 'reopened',
  ping: boolean,
): Promise<void> {
  const actor = await actorCredit(actorUserId);
  const team = teamPing(ping);
  await executeWebhook(
    discussionWebhookUrl(),
    {
      username: 'Curation discussion',
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
  const response = await fetch(`https://discord.com/api/v10/channels/${threadId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({archived: true, locked: true}),
  });
  if (response.status === 404) return 'missing';
  const text = await response.text();
  if (!response.ok) throw new Error(`Discord ${response.status}: ${text.slice(0, 300)}`);
  return 'closed';
}

async function reopenForumThread(threadId: string): Promise<'reopened' | 'missing'> {
  const token = await discordBotToken();
  if (!token) throw new Error('Discord bot token is not configured');
  const response = await fetch(`https://discord.com/api/v10/channels/${threadId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({archived: false, locked: false}),
  });
  if (response.status === 404) return 'missing';
  const text = await response.text();
  if (!response.ok) throw new Error(`Discord ${response.status}: ${text.slice(0, 300)}`);
  return 'reopened';
}

export async function createCurationThread(input: {
  levelId: number;
  reason: string;
  actorUserId: string;
  embedTitle?: string;
  ping?: boolean;
}): Promise<{url: string | null}> {
  const chart = await loadChart(input.levelId);
  const song = chart?.song || 'Unknown';
  const creator = creatorLabel(chart);
  const titled = withCreator(song, creator).replace(/\s+/g, ' ').trim();
  const threadName = `vote ${titled}`.slice(0, 100);
  const description = ['Reason:', input.reason || '—'].join('\n').slice(0, 4000);
  const mention = await createdByLine(input.actorUserId);
  const team = teamPing(input.ping === true);
  const videoUrl = await topScoreClearVideoUrl(input.levelId);
  const message = await executeWebhook(
    discussionWebhookUrl(),
    {
      username: 'Curation discussion',
      avatar_url: announcerAvatar,
      content: [team.text, titled, mention.content].filter(Boolean).join('\n').slice(0, 2000),
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
  if (videoUrl && message.channel_id) {
    try {
      await executeWebhook(
        discussionWebhookUrl(),
        {
          username: 'Curation discussion',
          avatar_url: announcerAvatar,
          content: videoUrl.slice(0, 2000),
          allowed_mentions: {parse: []},
        },
        {thread_id: message.channel_id, wait: 'true'},
      );
    } catch (error) {
      logger.warn('[curation-thread] Top clear follow-up failed', {
        levelId: input.levelId,
        threadId: message.channel_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const guildId = await activeGuildId();
  return {url: jumpUrl(guildId, message)};
}

export async function closeCurationThread(input: {
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

export async function reopenCurationThread(input: {
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
