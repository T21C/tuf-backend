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
import { DiscordWebhookGate } from '@/server/services/discord/DiscordWebhookGate.js';
import { AnnouncementDeliveryTracker } from '@/server/services/discord/AnnouncementDeliveryTracker.js';
import { AnnouncementJobService } from '@/server/services/announcements/AnnouncementJobService.js';
import { isWebhookRateLimitError } from '@/misc/webhook/index.js';

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

function buildRequiredWebhooksByPassId(
  passes: Pass[],
  configs: Map<number, Awaited<ReturnType<typeof getPassAnnouncementConfig>>>,
): Map<number, string[]> {
  const map = new Map<number, string[]>();
  for (const pass of passes) {
    const config = configs.get(pass.id);
    const urls = [...new Set((config?.channels || []).map(c => c.webhookUrl))];
    map.set(pass.id, urls);
  }
  return map;
}

function buildRequiredWebhooksByLevelTrackingId(
  rows: { id: number; levelId: number }[],
  configs: Map<number, Awaited<ReturnType<typeof getLevelAnnouncementConfig>>>,
): Map<number, string[]> {
  const map = new Map<number, string[]>();
  for (const row of rows) {
    const config = configs.get(row.levelId);
    const urls = [...new Set((config?.channels || []).map(c => c.webhookUrl))];
    map.set(row.id, urls);
  }
  return map;
}

/** Executes the same work as POST /v2/webhooks/passes (Discord + isAnnounced update). */
export async function runPassAnnouncementJob(passIds: number[]): Promise<void> {
  try {
    await DiscordWebhookGate.assertNotBlocked();
    await AnnouncementJobService.markRequestsSending('pass', passIds);

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

    if (passes.length === 0) {
      logger.info('[pass-announcement-job] No unannounced passes matched', { passIds });
      await AnnouncementJobService.markItemsDelivered('pass', passIds);
      await AnnouncementJobService.releaseConveyor('pass', passIds);
      return;
    }

    // Already-announced (or missing) IDs still marked sending above — finalize them.
    const foundIds = new Set(passes.map(p => p.id));
    const alreadyDoneIds = passIds.filter(id => !foundIds.has(id));
    if (alreadyDoneIds.length > 0) {
      await AnnouncementJobService.markItemsDelivered('pass', alreadyDoneIds);
      await AnnouncementJobService.releaseConveyor('pass', alreadyDoneIds);
    }

    const configs = new Map<number, Awaited<ReturnType<typeof getPassAnnouncementConfig>>>();
    for (const pass of passes) {
      if (!pass.level?.diffId) continue;
      const config = await getPassAnnouncementConfig(pass);
      configs.set(pass.id, config);
    }

    // Passes with no matching directives must not stay in `sending` forever.
    // Treat them like silent-remove: leave the unannounced list, mark tracker skipped.
    const noDestinationIds: number[] = [];
    const announceablePasses: Pass[] = [];
    for (const pass of passes) {
      const channels = configs.get(pass.id)?.channels || [];
      if (channels.length === 0) {
        noDestinationIds.push(pass.id);
      } else {
        announceablePasses.push(pass);
      }
    }

    if (noDestinationIds.length > 0) {
      logger.info('[pass-announcement-job] Skipping passes with no announcement destinations', {
        passIds: noDestinationIds,
      });
      await Pass.update(
        { isAnnounced: true },
        { where: { id: { [Op.in]: noDestinationIds }, isAnnounced: false } },
      );
      await AnnouncementJobService.markItemsSkipped('pass', noDestinationIds);
    }

    if (announceablePasses.length === 0) {
      await AnnouncementJobService.releaseConveyor('pass', passIds);
      return;
    }

    const requiredWebhooksByItemId = buildRequiredWebhooksByPassId(announceablePasses, configs);
    const allWebhookUrls = [...new Set(
      [...requiredWebhooksByItemId.values()].flat(),
    )];
    const alreadyDelivered = await AnnouncementDeliveryTracker.buildAlreadyDeliveredSet(
      'pass',
      announceablePasses.map(p => p.id),
      allWebhookUrls,
    );

    const channels = await createChannelMessages(announceablePasses, configs, { alreadyDelivered });
    if (channels.length === 0) {
      // All destinations already delivered (retry) — complete remaining items.
      await AnnouncementJobService.markItemsDelivered(
        'pass',
        announceablePasses.map(p => p.id),
      );
      await AnnouncementJobService.releaseConveyor('pass', passIds);
      return;
    }
    for (const channel of channels) {
      await sendMessages(channel, undefined, {
        kind: 'pass',
        requiredWebhooksByItemId,
      });
    }
  } catch (err) {
    if (isWebhookRateLimitError(err)) {
      await AnnouncementJobService.markKindBlocked('pass', err.message);
      throw err;
    }
    await AnnouncementJobService.markItemsFailed(
      'pass',
      passIds,
      err instanceof Error ? err.message : String(err),
    );
    await AnnouncementJobService.releaseConveyor('pass', passIds);
    throw err;
  }
}

/** Executes the same work as POST /v2/webhooks/levels. */
export async function runLevelAnnouncementJob(queueRowIds: number[]): Promise<void> {
  try {
    await DiscordWebhookGate.assertNotBlocked();
    await AnnouncementJobService.markRequestsSending('level', queueRowIds);

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
      await AnnouncementJobService.markItemsDelivered('level', queueRowIds);
      await AnnouncementJobService.releaseConveyor('level', queueRowIds);
      return;
    }

    const foundIds = new Set(rows.map(r => r.id));
    const alreadyDoneIds = queueRowIds.filter(id => !foundIds.has(id));
    if (alreadyDoneIds.length > 0) {
      await AnnouncementJobService.markItemsDelivered('level', alreadyDoneIds);
      await AnnouncementJobService.releaseConveyor('level', alreadyDoneIds);
    }

    const levels = rows.map(r => r.level!).filter(Boolean);
    const trackingIdByEntityId = new Map<number, number>();
    const levelIdByItemId = new Map<number, number>();
    for (const row of rows) {
      trackingIdByEntityId.set(row.levelId, row.id);
      levelIdByItemId.set(row.id, row.levelId);
    }

    const configs = new Map<number, Awaited<ReturnType<typeof getLevelAnnouncementConfig>>>();
    for (const level of levels) {
      if (!level.diffId) continue;
      configs.set(level.id, await getLevelAnnouncementConfig(level));
    }

    const noDestinationRows: typeof rows = [];
    const announceableRows: typeof rows = [];
    for (const row of rows) {
      const channels = configs.get(row.levelId)?.channels || [];
      if (channels.length === 0) {
        noDestinationRows.push(row);
      } else {
        announceableRows.push(row);
      }
    }

    if (noDestinationRows.length > 0) {
      const skipItemIds = noDestinationRows.map(r => r.id);
      const skipLevelIds = noDestinationRows.map(r => r.levelId);
      logger.info('[level-announcement-job] Skipping levels with no announcement destinations', {
        queueRowIds: skipItemIds,
        levelIds: skipLevelIds,
      });
      await markQueueRowsAnnounced(skipItemIds);
      await Level.update(
        { isAnnounced: true },
        { where: { id: { [Op.in]: skipLevelIds } } },
      );
      await AnnouncementJobService.markItemsSkipped('level', skipItemIds);
    }

    if (announceableRows.length === 0) {
      await AnnouncementJobService.releaseConveyor('level', queueRowIds);
      return;
    }

    const announceableLevels = announceableRows.map(r => r.level!).filter(Boolean);

    const requiredWebhooksByItemId = buildRequiredWebhooksByLevelTrackingId(
      announceableRows.map(r => ({ id: r.id, levelId: r.levelId })),
      configs,
    );
    const allWebhookUrls = [...new Set(
      [...requiredWebhooksByItemId.values()].flat(),
    )];
    const alreadyDelivered = await AnnouncementDeliveryTracker.buildAlreadyDeliveredSet(
      'level',
      announceableRows.map(r => r.id),
      allWebhookUrls,
    );

    const channels = await createChannelMessages(announceableLevels, configs, {
      alreadyDelivered,
      trackingIdByEntityId,
    });
    if (channels.length === 0) {
      await AnnouncementJobService.markItemsDelivered('level', announceableRows.map(r => r.id));
      await AnnouncementJobService.releaseConveyor('level', queueRowIds);
      return;
    }
    for (const channel of channels) {
      await sendMessages(channel, undefined, {
        kind: 'level',
        requiredWebhooksByItemId,
        levelIdByItemId,
      });
    }
  } catch (err) {
    if (isWebhookRateLimitError(err)) {
      await AnnouncementJobService.markKindBlocked('level', err.message);
      throw err;
    }
    await AnnouncementJobService.markItemsFailed(
      'level',
      queueRowIds,
      err instanceof Error ? err.message : String(err),
    );
    await AnnouncementJobService.releaseConveyor('level', queueRowIds);
    throw err;
  }
}

/** Executes the same work as POST /v2/webhooks/rerates. */
export async function runRerateAnnouncementJob(queueRowIds: number[]): Promise<void> {
  try {
    await DiscordWebhookGate.assertNotBlocked();
    await AnnouncementJobService.markRequestsSending('rerate', queueRowIds);

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
      await AnnouncementJobService.markItemsDelivered('rerate', queueRowIds);
      await AnnouncementJobService.releaseConveyor('rerate', queueRowIds);
      return;
    }

    const targets = parseRerateWebhookTargets();
    const targetUrls = targets.map(t => t.webhookUrl);
    const requiredWebhooksByItemId = new Map<number, string[]>();
    const levelIdByItemId = new Map<number, number>();
    for (const row of eligibleRows) {
      requiredWebhooksByItemId.set(row.id, targetUrls);
      levelIdByItemId.set(row.id, row.levelId);
    }

    const alreadyDelivered = await AnnouncementDeliveryTracker.buildAlreadyDeliveredSet(
      'rerate',
      eligibleRows.map(r => r.id),
      targetUrls,
    );

    const embedPairs = await Promise.all(
      eligibleRows.map(async row => ({
        queueRowId: row.id,
        embed: await createRerateEmbedFromQueue({
          level: row.level!,
          facets: row.facets,
          before: row.before,
          after: row.after,
        }),
      })),
    );

    const rerateChannels: ChannelMessages[] = [];

    for (let i = 0; i < targets.length; i++) {
      const { webhookUrl, ping } = targets[i];
      const pendingPairs = embedPairs.filter(
        p =>
          !alreadyDelivered.has(
            AnnouncementDeliveryTracker.deliveryPairKey(p.queueRowId, webhookUrl),
          ),
      );
      if (pendingPairs.length === 0) continue;

      const rerateMessages: ChannelMessage[] = [];
      for (let j = 0; j < pendingPairs.length; j += 8) {
        const batch = pendingPairs.slice(j, j + 8);
        rerateMessages.push(
          createEmbedBatchMessage(
            batch.map(p => p.embed),
            j === 0 ? ping : undefined,
            batch.map(p => p.queueRowId),
          ),
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
      await sendMessages(channel, channel.channelConfig.ping, {
        kind: 'rerate',
        requiredWebhooksByItemId,
        levelIdByItemId,
      });
    }

    if (rerateChannels.length === 0) {
      await AnnouncementJobService.markItemsDelivered('rerate', eligibleRows.map(r => r.id));
      await AnnouncementJobService.releaseConveyor('rerate', queueRowIds);
    }
  } catch (err) {
    if (isWebhookRateLimitError(err)) {
      await AnnouncementJobService.markKindBlocked('rerate', err.message);
      throw err;
    }
    await AnnouncementJobService.markItemsFailed(
      'rerate',
      queueRowIds,
      err instanceof Error ? err.message : String(err),
    );
    await AnnouncementJobService.releaseConveyor('rerate', queueRowIds);
    throw err;
  }
}
