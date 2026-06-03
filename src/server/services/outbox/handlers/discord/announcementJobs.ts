import { Op } from 'sequelize';
import Pass from '@/models/passes/Pass.js';
import Level from '@/models/levels/Level.js';
import Difficulty from '@/models/levels/Difficulty.js';
import Creator from '@/models/credits/Creator.js';
import Team from '@/models/credits/Team.js';
import User from '@/models/auth/User.js';
import Judgement from '@/models/passes/Judgement.js';
import Player from '@/models/players/Player.js';
import LevelCredit from '@/models/levels/LevelCredit.js';
import LevelAnnouncementQueue from '@/models/levels/LevelAnnouncementQueue.js';
import { getPassAnnouncementConfig, getLevelAnnouncementConfig } from '@/server/routes/v2/webhooks/channelParser.js';
import {
  createChannelMessages,
  sendMessages,
  createEmbedBatchMessage,
} from '@/server/routes/v2/webhooks/webhook.js';
import { createRerateEmbedFromQueue } from '@/server/routes/v2/webhooks/rerateEmbedSections.js';
import {
  computeAnnouncementFacets,
  hasMeaningfulAnnouncementChange,
  markQueueRowsAnnounced,
} from '@/server/services/announcements/levelAnnouncementQueue.js';
import { logger } from '@/server/services/core/LoggerService.js';
import type { ChannelMessage, ChannelMessages } from '@/server/routes/v2/webhooks/webhook.js';

function parseRerateWebhookTargets(): { webhookUrl: string; ping?: string }[] {
  const webhookUrls = (process.env.RERATE_ANNOUNCEMENT_HOOK || '')
    .split(',')
    .map(url => url.trim())
    .filter(url => url.length > 0);

  let pingRoleIds = (process.env.RERATE_PING_ROLE_ID || '')
    .split(',')
    .map(id => id.trim());

  if (webhookUrls.length === 0) {
    throw new Error('RERATE_ANNOUNCEMENT_HOOK is not configured');
  }

  if (pingRoleIds.length !== webhookUrls.length) {
    logger.warn('[rerate-job] RERATE_ANNOUNCEMENT_HOOK and RERATE_PING_ROLE_ID count mismatch; padding missing pings', {
      webhookCount: webhookUrls.length,
      roleIdCount: pingRoleIds.length,
    });
    while (pingRoleIds.length < webhookUrls.length) {
      pingRoleIds.push('');
    }
    if (pingRoleIds.length > webhookUrls.length) {
      pingRoleIds = pingRoleIds.slice(0, webhookUrls.length);
    }
  }

  return webhookUrls.map((webhookUrl, i) => {
    const pingRoleId = pingRoleIds[i];
    const ping = pingRoleId ? `<@&${pingRoleId}>` : undefined;
    return { webhookUrl, ping };
  });
}

/** Executes the same work as POST /v2/webhooks/passes (Discord + isAnnounced update). */
export async function runPassAnnouncementJob(passIds: number[]): Promise<void> {
  const passes = await Pass.findAll({
    where: { id: { [Op.in]: passIds }, isAnnounced: false },
    include: [
      {
        model: Level,
        as: 'level',
        include: [
          { model: Difficulty, as: 'difficulty' },
          {
            model: LevelCredit,
            as: 'levelCredits',
            include: [{ model: Creator, as: 'creator' }],
          },
          { model: Team, as: 'teamObject' },
        ],
      },
      {
        model: Player,
        as: 'player',
        include: [
          {
            model: User,
            as: 'user',
            attributes: ['avatarUrl', 'username', 'nickname'],
            required: false,
          },
        ],
      },
      { model: Judgement, as: 'judgements' },
    ],
  });

  const configs = new Map();
  for (const pass of passes) {
    if (!pass.level?.diffId) continue;
    const config = await getPassAnnouncementConfig(pass);
    configs.set(pass.id, config);
  }

  const channels = await createChannelMessages(passes, configs);
  for (const channel of channels) {
    await sendMessages(channel);
  }

  if (passes.length > 0) {
    await Pass.update(
      { isAnnounced: true },
      { where: { id: { [Op.in]: passes.map(p => p.id) } } },
    );
  }
}

/** Executes the same work as POST /v2/webhooks/levels. */
export async function runLevelAnnouncementJob(queueRowIds: number[]): Promise<void> {
  const rows = await LevelAnnouncementQueue.findAll({
    where: {
      id: { [Op.in]: queueRowIds },
      status: 'PENDING',
      kind: 'NEW',
    },
    include: [
      {
        model: Level,
        as: 'level',
        where: { isDeleted: false },
        required: true,
        include: [{ model: Difficulty, as: 'difficulty' }],
      },
    ],
  });

  if (rows.length === 0) {
    logger.warn('[level-announcement-job] No pending NEW queue rows matched', { queueRowIds });
    return;
  }

  const levels = rows.map(r => r.level!).filter(Boolean);
  const configs = new Map<number, Awaited<ReturnType<typeof getLevelAnnouncementConfig>>>();
  for (const level of levels) {
    if (!level.diffId) continue;
    configs.set(level.id, await getLevelAnnouncementConfig(level));
  }

  const channels = await createChannelMessages(levels, configs);
  for (const channel of channels) {
    await sendMessages(channel);
  }

  const announcedRowIds = rows.map(r => r.id);
  await markQueueRowsAnnounced(announcedRowIds);
  await Level.update(
    { isAnnounced: true },
    { where: { id: { [Op.in]: levels.map(l => l.id) } } },
  );
}

/** Executes the same work as POST /v2/webhooks/rerates. */
export async function runRerateAnnouncementJob(queueRowIds: number[]): Promise<void> {
  const rows = await LevelAnnouncementQueue.findAll({
    where: {
      id: { [Op.in]: queueRowIds },
      status: 'PENDING',
      kind: 'RERATE',
    },
    include: [
      {
        model: Level,
        as: 'level',
        where: { isDeleted: false },
        required: true,
        include: [{ model: Difficulty, as: 'difficulty' }],
      },
    ],
  });

  const eligibleRows = rows.filter(row => {
    const facets = row.facets?.length
      ? row.facets
      : computeAnnouncementFacets(row.before, row.after);
    return hasMeaningfulAnnouncementChange(facets);
  });

  if (eligibleRows.length === 0) {
    logger.warn('[rerate-job] No eligible rerate queue rows to announce', { queueRowIds });
    return;
  }

  const embeds = await Promise.all(
    eligibleRows.map(row =>
      createRerateEmbedFromQueue({
        level: row.level!,
        facets: row.facets,
        before: row.before,
        after: row.after,
      }),
    ),
  );

  const targets = parseRerateWebhookTargets();
  const rerateChannels: ChannelMessages[] = [];

  for (let i = 0; i < targets.length; i++) {
    const { webhookUrl, ping } = targets[i];
    const rerateMessages: ChannelMessage[] = [];
    for (let j = 0; j < embeds.length; j += 8) {
      rerateMessages.push(
        createEmbedBatchMessage(embeds.slice(j, j + 8), j === 0 ? ping : undefined),
      );
    }

    rerateChannels.push({
      webhookUrl,
      channelConfig: {
        label: `rerates-${i}`,
        webhookUrl,
        ping,
      },
      messages: rerateMessages,
    });
  }

  for (const channel of rerateChannels) {
    await sendMessages(channel, channel.channelConfig.ping);
  }

  const announcedRowIds = eligibleRows.map(r => r.id);
  await markQueueRowsAnnounced(announcedRowIds);
  await Level.update(
    { isAnnounced: true },
    { where: { id: { [Op.in]: eligibleRows.map(r => r.levelId) } } },
  );
}
