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
import { getPassAnnouncementConfig, getLevelAnnouncementConfig } from '@/server/routes/v2/webhooks/channelParser.js';
import {
  createChannelMessages,
  sendMessages,
  UPDATE_AFTER_ANNOUNCEMENT,
  createEmbedBatchMessage,
} from '@/server/routes/v2/webhooks/webhook.js';
import { createRerateEmbed } from '@/server/routes/v2/webhooks/embeds.js';
import { logger } from '@/server/services/core/LoggerService.js';
import type { ChannelMessage, ChannelMessages } from '@/server/routes/v2/webhooks/webhook.js';

/** Executes the same work as POST /v2/webhooks/passes (Discord + optional isAnnounced update). */
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

  if (UPDATE_AFTER_ANNOUNCEMENT) {
    await Pass.update({ isAnnounced: true }, { where: { id: { [Op.in]: passIds } } });
  }
}

/** Executes the same work as POST /v2/webhooks/levels. */
export async function runLevelAnnouncementJob(levelIds: number[]): Promise<void> {
  const levels = await Level.findAll({
    where: { id: { [Op.in]: levelIds }, isAnnounced: false },
    include: [{ model: Difficulty, as: 'difficulty' }],
  });

  const configs = new Map();
  for (const level of levels) {
    if (!level.diffId) continue;
    const config = await getLevelAnnouncementConfig(level);
    configs.set(level.id, config);
  }

  const channels = await createChannelMessages(levels, configs);
  for (const channel of channels) {
    await sendMessages(channel);
  }

  if (UPDATE_AFTER_ANNOUNCEMENT) {
    await Level.update({ isAnnounced: true }, { where: { id: { [Op.in]: levelIds } } });
  }
}

/** Executes the same work as POST /v2/webhooks/rerates. */
export async function runRerateAnnouncementJob(levelIds: number[]): Promise<void> {
  const rawLevels = await Level.findAll({
    where: { id: { [Op.in]: levelIds }, isAnnounced: false },
    include: [
      { model: Difficulty, as: 'difficulty' },
      { model: Difficulty, as: 'previousDifficulty' },
    ],
  });

  const levels = rawLevels.filter((level) => {
    const previousBaseScore = level.previousBaseScore || level.previousDifficulty?.baseScore || 0;
    const currentBaseScore = level.baseScore || level.difficulty?.baseScore || 0;
    return previousBaseScore !== currentBaseScore || level.previousDiffId !== level.diffId;
  });

  const embeds = await Promise.all(levels.map((level) => createRerateEmbed(level as Level)));

  const webhookUrls = (process.env.RERATE_ANNOUNCEMENT_HOOK || '')
    .split(',')
    .map((url) => url.trim())
    .filter((url) => url.length > 0);

  const pingRoleIds = (process.env.RERATE_PING_ROLE_ID || '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);

  if (webhookUrls.length !== pingRoleIds.length) {
    logger.warn('[rerate-job] RERATE_ANNOUNCEMENT_HOOK and RERATE_PING_ROLE_ID count mismatch', {
      webhookCount: webhookUrls.length,
      roleIdCount: pingRoleIds.length,
    });
    throw new Error('RERATE_ANNOUNCEMENT_HOOK and RERATE_PING_ROLE_ID must have the same number of entries');
  }

  if (webhookUrls.length === 0) {
    throw new Error('RERATE_ANNOUNCEMENT_HOOK is not configured');
  }

  const rerateChannels: ChannelMessages[] = [];

  for (let i = 0; i < webhookUrls.length; i++) {
    const webhookUrl = webhookUrls[i];
    const pingRoleId = pingRoleIds[i];
    const ping = pingRoleId ? `<@&${pingRoleId}>` : undefined;

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
        ping: ping,
      },
      messages: rerateMessages,
    });
  }

  for (const channel of rerateChannels) {
    await sendMessages(channel, channel.channelConfig.ping);
  }

  if (UPDATE_AFTER_ANNOUNCEMENT) {
    await Level.update({ isAnnounced: true }, { where: { id: { [Op.in]: levelIds } } });
  }
}
