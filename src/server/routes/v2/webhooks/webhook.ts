import express, {Request, Response, Router} from 'express';
import Pass from '@/models/passes/Pass.js';
import Difficulty from '@/models/levels/Difficulty.js';
import Level from '@/models/levels/Level.js';
import {Webhook, MessageBuilder} from '@/misc/webhook/index.js';
import Player from '@/models/players/Player.js';
import {Op} from 'sequelize';
import {
  createClearEmbed,
  createNewLevelEmbed,
  formatString,
  trim,
  wrap,
} from './embeds.js';
import Judgement from '@/models/passes/Judgement.js';
import {
  getPassAnnouncementConfig,
  getLevelAnnouncementConfig,
  AnnouncementConfig,
  AnnouncementChannelConfig,
} from './channelParser.js';
import {PassSubmission} from '@/models/submissions/PassSubmission.js';
import {getVideoDetails} from '@/misc/utils/data/videoDetailParser.js';
import { getPrimaryVideoLink } from '@/misc/utils/data/videoLinkParts.js';
import LevelSubmission from '@/models/submissions/LevelSubmission.js';
import {calcAcc, IJudgements} from '@/misc/utils/pass/CalcAcc.js';
import {Auth} from '@/server/middleware/auth.js';
import {ApiDoc} from '@/server/middleware/apiDoc.js';
import {
  docRequestBody,
  levelIdsBodySchema,
  passIdsBodySchema,
  queueRowIdsBodySchema,
  standardErrorResponses400500,
} from '@/server/schemas/v2/webhooks/index.js';
import { logger } from '@/server/services/core/LoggerService.js';
import {
  clientUrlEnv,
  shouldDeliverDiscordAnnouncementWebhooks,
  resolveDiscordAnnouncementWebhookUrl,
  getDiscordAnnouncementWebhookOverride,
} from '@/config/app.config.js';
import { User } from '@/models/index.js';
import { formatCredits } from '@/misc/utils/Utility.js';
import Creator from '@/models/credits/Creator.js';
import LevelCredit from '@/models/levels/LevelCredit.js';
import Team from '@/models/credits/Team.js';
import { markQueueRowsSkipped } from '@/server/services/announcements/levelAnnouncementQueue.js';
import crypto from 'crypto';
import { OutboxService } from '@/server/services/outbox/OutboxService.js';
import { OUTBOX_EVENT_TYPES } from '@/server/services/outbox/events.js';
import { DiscordWebhookGate } from '@/server/services/discord/DiscordWebhookGate.js';
import type {
  AnnouncementDeliveryKind,
} from '@/server/services/discord/AnnouncementDeliveryTracker.js';
import { AnnouncementDeliveryTracker } from '@/server/services/discord/AnnouncementDeliveryTracker.js';
import { AnnouncementJobService } from '@/server/services/announcements/AnnouncementJobService.js';
import LevelAnnouncementQueue from '@/models/levels/LevelAnnouncementQueue.js';
import { isWebhookRateLimitError } from '@/misc/webhook/index.js';

const router: Router = express.Router();

const placeHolder = 'https://soggy.cat/static/ssoggycat/main/images/soggycat.webp';
const botAvatar = process.env.BOT_AVATAR_URL || placeHolder;

export const UPDATE_AFTER_ANNOUNCEMENT = true;

// Interface for individual messages in a channel
export interface ChannelMessage {
  type: 'text' | 'embeds';
  content?: string; // Plain text content (for headers or to add to embed batch)
  embeds?: MessageBuilder[]; // Embed batch (can have content added to first embed)
  /** Entity ids represented in this message (pass id or queue row id). */
  itemIds?: number[];
}

// Interface to track messages for each channel
export interface ChannelMessages {
  webhookUrl: string;
  channelConfig: AnnouncementChannelConfig;
  messages: ChannelMessage[]; // Sequence of messages (headers + embed batches)
}

export type SendMessagesDeliveryContext = {
  kind: AnnouncementDeliveryKind;
  requiredWebhooksByItemId: Map<number, string[]>;
  levelIdByItemId?: Map<number, number>;
};

// Helper to render message format template with variables
function renderMessageFormat(format: string, variables: {
  count: number;
  difficultyName?: string;
  ping: string;
}): string {
  let result = format;
  result = result.replace(/\{count\}/g, String(variables.count));

  if (variables.difficultyName !== undefined) {
    result = result.replace(/\{difficultyName\}/g, variables.difficultyName);
  } else {
    result = result.replace(/\{difficultyName\}/g, '');
  }

  result = result.replace(/\{ping\}/g, variables.ping || '');
  result = result.replace(/\s+/g, ' ').trim();
  return result;
}

type EmbedItemPair = { embed: MessageBuilder; itemId: number };

// Helper to create embed batch message with optional content
export function createEmbedBatchMessage(
  embeds: MessageBuilder[],
  content?: string,
  itemIds?: number[],
): ChannelMessage {
  return {
    type: 'embeds',
    embeds,
    ...(content && { content }),
    ...(itemIds && itemIds.length > 0 ? { itemIds } : {}),
  };
}

function pushEmbedBatches(
  messages: ChannelMessage[],
  pairs: EmbedItemPair[],
  firstContent?: string,
): void {
  for (let i = 0; i < pairs.length; i += 8) {
    const batch = pairs.slice(i, i + 8);
    messages.push(
      createEmbedBatchMessage(
        batch.map(p => p.embed),
        i === 0 ? firstContent : undefined,
        batch.map(p => p.itemId),
      ),
    );
  }
}

// Process items and create embeds using channel list from configs
export async function createChannelMessages(
  items: (Pass | Level)[],
  configs: Map<number, AnnouncementConfig>,
  options?: {
    alreadyDelivered?: Set<string>;
    /** Maps entity.id → progress-tracking id (e.g. levelId → queueRowId). Defaults to entity.id. */
    trackingIdByEntityId?: Map<number, number>;
  },
): Promise<ChannelMessages[]> {
  const channelMessages = new Map<string, ChannelMessages>();
  const alreadyDelivered = options?.alreadyDelivered;
  const trackingIdByEntityId = options?.trackingIdByEntityId;
  const trackingIdFor = (entityId: number) =>
    trackingIdByEntityId?.get(entityId) ?? entityId;

  logger.debug(`[Message Processing] Processing ${items.length} item(s)`);

  logger.debug('[Message Processing] Webhook configs:', {configs: Array.from(configs.entries())});
  // Collect all items per webhook URL, preserving channel config
  const webhookData = new Map<string, {
    items: (Pass | Level)[];
    channelConfig: AnnouncementChannelConfig;
    roleGroups: Map<number, (Pass | Level)[]>; // roleId -> items for this role
  }>();

  for (const item of items) {
    const config = configs.get(item.id);
    if (!config) continue;

    for (const channel of config.channels) {
      const trackingId = trackingIdFor(item.id);
      if (
        alreadyDelivered?.has(
          AnnouncementDeliveryTracker.deliveryPairKey(trackingId, channel.webhookUrl),
        )
      ) {
        continue;
      }

      if (!webhookData.has(channel.webhookUrl)) {
        webhookData.set(channel.webhookUrl, {
          items: [],
          channelConfig: {
            ...channel,
            messageFormats: channel.messageFormats ? [...channel.messageFormats] : []
          },
          roleGroups: new Map()
        });
      }

      const data = webhookData.get(channel.webhookUrl)!;
      if (!data.items.find(i => i.id === item.id)) {
        data.items.push(item);
      }

      // Merge messageFormats from this channel into the webhook's config
      if (channel.messageFormats && channel.messageFormats.length > 0) {
        if (!data.channelConfig.messageFormats) {
          data.channelConfig.messageFormats = [];
        }

        // Add formats that don't already exist (by roleId + actionId + directiveId)
        for (const format of channel.messageFormats) {
          const exists = data.channelConfig.messageFormats.some(f =>
            f.roleId === format.roleId &&
            f.actionId === format.actionId &&
            f.directiveId === format.directiveId
          );
          if (!exists) {
            data.channelConfig.messageFormats.push(format);
          }
        }

        // Group by roleId
        for (const format of channel.messageFormats) {
          const roleId = format.roleId;
          if (!data.roleGroups.has(roleId)) {
            data.roleGroups.set(roleId, []);
          }
          const roleItems = data.roleGroups.get(roleId)!;
          if (!roleItems.find(i => i.id === item.id)) {
            roleItems.push(item);
          }
        }
      }
    }
  }

  // Create messages for each webhook
  for (const [webhookUrl, data] of webhookData) {
    const messages: ChannelMessage[] = [];
    const embeddedItems = new Set<number>(); // Track items that have been sent as embeds

    // If we have messageFormats, group by roleId and create headers
    if (data.channelConfig.messageFormats && data.channelConfig.messageFormats.length > 0) {

      // Sort formats by directiveSortOrder
      const sortedFormats = [...data.channelConfig.messageFormats].sort(
        (a, b) => (a.directiveSortOrder || 0) - (b.directiveSortOrder || 0)
      );

      // Separate formats into generic (no {difficultyName}) and specific (has {difficultyName})
      const genericFormats = sortedFormats.filter(f => !f.messageFormat.includes('{difficultyName}'));
      const specificFormats = sortedFormats.filter(f => f.messageFormat.includes('{difficultyName}'));

      // First: Collect generic format headers (but don't send embeds yet if specific formats exist)
      // Deduplicate generic formats by roleId + messageFormat to avoid duplicates
      const uniqueGenericFormats = new Map<string, typeof genericFormats[0]>();
      for (const format of genericFormats) {
        const formatKey = `${format.roleId}:${format.messageFormat}`;
        if (!uniqueGenericFormats.has(formatKey)) {
          uniqueGenericFormats.set(formatKey, format);
        }
      }

      const genericHeaders: string[] = [];
      for (const format of uniqueGenericFormats.values()) {
        const allRoleItems = data.roleGroups.get(format.roleId) || [];
        if (allRoleItems.length === 0) continue;

        const headerText = renderMessageFormat(format.messageFormat, {
          count: allRoleItems.length,
          ping: format.ping
        });
        genericHeaders.push(headerText);
      }

      // Second: Process specific formats (with {difficultyName}) - send headers + embeds
      for (const format of specificFormats) {
        const allRoleItems = data.roleGroups.get(format.roleId) || [];
        if (allRoleItems.length === 0) continue;

        // Get difficulty name
        const firstItem = allRoleItems[0];
        let difficultyName: string | undefined;
        if ('level' in firstItem) {
          difficultyName = (firstItem as Pass).level?.difficulty?.name;
        } else {
          difficultyName = (firstItem as Level).difficulty?.name;
        }

        // Render header message with count from ALL role items
        const headerText = renderMessageFormat(format.messageFormat, {
          count: allRoleItems.length,
          difficultyName,
          ping: format.ping
        });

        // Send header + embeds (only for items not yet embedded)
        const itemsToEmbed = allRoleItems.filter(item => !embeddedItems.has(item.id));

        if (itemsToEmbed.length > 0) {
          const rolePairs: EmbedItemPair[] = [];
          for (const item of itemsToEmbed) {
            if ('level' in item) {
              rolePairs.push({
                embed: await createClearEmbed(item as Pass),
                itemId: trackingIdFor(item.id),
              });
            } else {
              rolePairs.push({
                embed: await createNewLevelEmbed(item as Level),
                itemId: trackingIdFor(item.id),
              });
            }
            embeddedItems.add(item.id);
          }

          pushEmbedBatches(messages, rolePairs, headerText);
        } else {
          // All items already embedded, just send header as plain text
          messages.push({
            type: 'text',
            content: headerText
          });
        }
      }
      // Check if ANY format has {difficultyName}
      const hasAnyDifficultyNameFormat = data.channelConfig.messageFormats.some(
        f => f.messageFormat.includes('{difficultyName}')
      );
      // Third: Send generic headers once before all embeds (if specific formats exist)
      // OR send generic headers with embeds (if no specific formats exist)
      if (hasAnyDifficultyNameFormat) {
        // Collect unembedded items from generic role groups
        const unembeddedGenericItems: (Pass | Level)[] = [];
        for (const format of uniqueGenericFormats.values()) {
          const allRoleItems = data.roleGroups.get(format.roleId) || [];
          for (const item of allRoleItems) {
            if (!embeddedItems.has(item.id) && !unembeddedGenericItems.find(i => i.id === item.id)) {
              unembeddedGenericItems.push(item);
            }
          }
        }

        if (unembeddedGenericItems.length > 0) {
          // Create embeds for items only in generic role groups
          const genericPairs: EmbedItemPair[] = [];
          for (const item of unembeddedGenericItems) {
            if ('level' in item) {
              genericPairs.push({
                embed: await createClearEmbed(item as Pass),
                itemId: trackingIdFor(item.id),
              });
            } else {
              genericPairs.push({
                embed: await createNewLevelEmbed(item as Level),
                itemId: trackingIdFor(item.id),
              });
            }
            embeddedItems.add(item.id);
          }

          // Combine all generic headers into one string
          const combinedHeaders = genericHeaders.join('\n');

          // Send headers + embeds for unembedded generic items
          const genericMessages: ChannelMessage[] = [];
          pushEmbedBatches(genericMessages, genericPairs, combinedHeaders);
          messages.unshift(...genericMessages);
        } else {
          // All items already embedded by specific formats, just send generic headers as plain text
          for (const headerText of genericHeaders) {
            messages.unshift({
              type: 'text',
              content: headerText
            });
          }
        }
      } else {
        // No specific formats - send generic headers with embeds
        // Use uniqueGenericFormats to avoid duplicates
        for (const format of uniqueGenericFormats.values()) {
          const allRoleItems = data.roleGroups.get(format.roleId) || [];
          if (allRoleItems.length === 0) continue;

          const headerText = renderMessageFormat(format.messageFormat, {
            count: allRoleItems.length,
            ping: format.ping
          });

          const itemsToEmbed = allRoleItems.filter(item => !embeddedItems.has(item.id));

          if (itemsToEmbed.length > 0) {
            const rolePairs: EmbedItemPair[] = [];
            for (const item of itemsToEmbed) {
              if ('level' in item) {
                rolePairs.push({
                  embed: await createClearEmbed(item as Pass),
                  itemId: trackingIdFor(item.id),
                });
              } else {
                rolePairs.push({
                  embed: await createNewLevelEmbed(item as Level),
                  itemId: trackingIdFor(item.id),
                });
              }
              embeddedItems.add(item.id);
            }

            pushEmbedBatches(messages, rolePairs, headerText);
          } else {
            messages.push({
              type: 'text',
              content: headerText
            });
          }
        }
      }
    } else {
      // No messageFormats - just create embeds without headers
      const pairs: EmbedItemPair[] = [];
      for (const item of data.items) {
        if ('level' in item) {
          pairs.push({
            embed: await createClearEmbed(item as Pass),
            itemId: trackingIdFor(item.id),
          });
        } else {
          pairs.push({
            embed: await createNewLevelEmbed(item as Level),
            itemId: trackingIdFor(item.id),
          });
        }
      }

      pushEmbedBatches(messages, pairs);
    }

    channelMessages.set(webhookUrl, {
      webhookUrl,
      channelConfig: data.channelConfig,
      messages,
    });

    logger.debug(`[Message Processing] Webhook ${webhookUrl}: ${messages.length} message(s)`);
  }

  return Array.from(channelMessages.values());
}

function summarizeAnnouncementPayload(
  channel: ChannelMessages,
  message?: string,
): Record<string, unknown> {
  let webhookHost = 'unknown';
  try {
    webhookHost = new URL(channel.webhookUrl).hostname;
  } catch {
    webhookHost = 'invalid-url';
  }

  return {
    label: channel.channelConfig?.label,
    webhookHost,
    fallbackMessage: message,
    messages: channel.messages.map(msg => {
      if (msg.type === 'text') {
        return { type: 'text', content: msg.content ?? message ?? '' };
      }
      const combined =
        msg.embeds && msg.embeds.length > 0
          ? MessageBuilder.combine(...msg.embeds)
          : null;
      if (msg.content && combined) {
        combined.setText(msg.content);
      }
      return {
        type: 'embeds',
        content: msg.content,
        embedCount: msg.embeds?.length ?? 0,
        payload: combined?.getJSON() ?? null,
      };
    }),
  };
}

async function recordDeliveryAndNotify(
  delivery: SendMessagesDeliveryContext,
  itemIds: number[],
  webhookUrl: string,
  webhookLabel: string,
  batchId: string,
): Promise<void> {
  const newlyCompleted = await AnnouncementDeliveryTracker.recordMessageDelivered({
    kind: delivery.kind,
    itemIds,
    webhookUrl,
    requiredWebhooksByItemId: delivery.requiredWebhooksByItemId,
    levelIdByItemId: delivery.levelIdByItemId,
  });

  for (const itemId of itemIds) {
    const required = delivery.requiredWebhooksByItemId.get(itemId) || [];
    const delivered = await AnnouncementDeliveryTracker.getDeliveredWebhookHashes(
      delivery.kind,
      itemId,
    );
    const destinationsDone = required.filter(url =>
      delivered.has(AnnouncementDeliveryTracker.hashWebhookUrl(url)),
    ).length;
    await AnnouncementJobService.upsertBatchForItems({
      kind: delivery.kind,
      itemIds: [itemId],
      batchId,
      webhookLabel,
      status: newlyCompleted.includes(itemId) ? 'sent' : 'sent',
      destinationsDone,
      destinationsRequired: Math.max(1, required.length),
    });
  }

  if (newlyCompleted.length > 0) {
    await AnnouncementJobService.markItemsDelivered(delivery.kind, newlyCompleted);
  }
}

// Helper to send embeds for a channel (levels / rerates / passes batch announcements)
export async function sendMessages(
  channel: ChannelMessages,
  message?: string,
  delivery?: SendMessagesDeliveryContext,
): Promise<void> {
  const webhookLabel =
    channel.channelConfig?.label ||
    `webhook-${AnnouncementDeliveryTracker.hashWebhookUrl(channel.webhookUrl)}`;
  const batchId = AnnouncementDeliveryTracker.hashWebhookUrl(channel.webhookUrl);

  try {
    if (!shouldDeliverDiscordAnnouncementWebhooks()) {
      logger.info('[discord-announcement] Development dry-run — skipping webhook delivery', {
        summary: summarizeAnnouncementPayload(channel, message),
      });
      if (delivery) {
        for (const msg of channel.messages) {
          if (msg.itemIds && msg.itemIds.length > 0) {
            await AnnouncementJobService.upsertBatchForItems({
              kind: delivery.kind,
              itemIds: msg.itemIds,
              batchId,
              webhookLabel,
              status: 'sending',
              destinationsRequired: 1,
            });
            await recordDeliveryAndNotify(
              delivery,
              msg.itemIds,
              channel.webhookUrl,
              webhookLabel,
              batchId,
            );
          }
        }
      }
      return;
    }

    // Outbox already retries with backoff; disable nested 429 retries here so we don't
    // multiply announcement attempts against Discord/Cloudflare.
    const sendUrl = resolveDiscordAnnouncementWebhookUrl(channel.webhookUrl);
    const webhookOverride = getDiscordAnnouncementWebhookOverride();
    if (webhookOverride) {
      logger.info('[discord-announcement] Using DISCORD_ANNOUNCEMENT_WEBHOOK_OVERRIDE for send', {
        label: channel.channelConfig?.label,
        originalHost: (() => {
          try {
            return new URL(channel.webhookUrl).hostname;
          } catch {
            return 'invalid-url';
          }
        })(),
      });
    }
    const hook = new Webhook({
      url: sendUrl,
      throwErrors: true,
      retryOnLimit: false,
    });
    hook.setUsername('TUF Announcer');
    hook.setAvatar(botAvatar);

    for (const msg of channel.messages) {
      if (msg.type === 'text') {
        // Send plain text message
        const textMessage = msg.content || message || '';
        if (textMessage) {
          const plainTextMessage = new MessageBuilder().setText(textMessage);
          await hook.send(plainTextMessage);
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      } else if (msg.type === 'embeds' && msg.embeds && msg.embeds.length > 0) {
        // Send embed batch
        const combinedEmbed = MessageBuilder.combine(...msg.embeds);

        // Add content to embed batch if provided (from msg.content or fallback message)
        const textContent = msg.content || (message && channel.messages.indexOf(msg) === 0 ? message : undefined);
        if (textContent) {
          combinedEmbed.setText(textContent);
        }

        if (delivery && msg.itemIds && msg.itemIds.length > 0) {
          await AnnouncementJobService.upsertBatchForItems({
            kind: delivery.kind,
            itemIds: msg.itemIds,
            batchId,
            webhookLabel,
            status: 'sending',
            destinationsRequired: Math.max(
              1,
              ...msg.itemIds.map(id => (delivery.requiredWebhooksByItemId.get(id) || []).length),
            ),
          });
        }

        await hook.send(combinedEmbed);

        if (delivery && msg.itemIds && msg.itemIds.length > 0) {
          await recordDeliveryAndNotify(
            delivery,
            msg.itemIds,
            channel.webhookUrl,
            webhookLabel,
            batchId,
          );
        }

        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  } catch (err) {
    if (isWebhookRateLimitError(err) && delivery) {
      await AnnouncementJobService.markKindBlocked(
        delivery.kind,
        err.message || 'Discord webhook rate limited',
      );
    }
    throw err;
  }
}


export async function levelSubmissionHook(levelSubmission: LevelSubmission) {
  if (!process.env.LEVEL_SUBMISSION_HOOK) {
    logger.warn('LEVEL_SUBMISSION_HOOK environment variable is not set, skipping webhook');
    return;
  }

  const hook = new Webhook(process.env.LEVEL_SUBMISSION_HOOK);
  hook.setUsername('TUF Level Submissions');
  hook.setAvatar(botAvatar);

  if (!levelSubmission)
    return new MessageBuilder().setDescription('No level info available');
  const level = levelSubmission.dataValues as LevelSubmission;

  const song = level?.song || null;
  const diff = level?.diff || null;
  const artist = level?.artist || null;
  const videoLink = level?.videoLink || null;
  const primaryVideoLink = getPrimaryVideoLink(videoLink);
  const videoInfo = videoLink
    ? await getVideoDetails(videoLink).then(details => details)
    : null;
  const submitter: User | null = level?.levelSubmitter || null;
  // Process creators by role
  const charters = level.creatorRequests
    ?.filter(req => req.role === 'charter')
    .map(req => req.creatorName) || [];
  const vfxers = level.creatorRequests
    ?.filter(req => req.role === 'vfxer')
    .map(req => req.creatorName) || [];

  const chartersString = charters.length > 0 ? charters.join(' & ') : 'Unknown';
  const vfxersString = vfxers.length > 0 ? vfxers.join(' & ') : null;
  const teamName = level.teamRequestData?.teamName || null;
  const discordId = submitter?.providers?.find(provider => provider.provider === 'discord')?.providerId || null;
  const embed = new MessageBuilder()
    .setColor('#000000')
    .setAuthor('New level submission', submitter?.avatarUrl || '', '')
    .setTitle(`${song || 'Unknown Song'} - ${artist || 'Unknown Artist'}`)
    .addField('', `${discordId ? `<@${discordId}>` : `@${submitter?.nickname}`} #${submitter?.playerId}`, false)
    .addField('Suggested Difficulty', `**${diff || 'None'}**`, true)
    .addField('', '', false);

  if (teamName) embed.addField('', `Team\n**${formatString(teamName)}**`, true);
  if (vfxersString) embed.addField('', `VFX\n**${formatString(vfxersString)}**`, true);
  embed.addField('', `Chart\n**${formatString(chartersString)}**`, true);

  embed
    .addField(
      '',
      `**${primaryVideoLink ? `[${wrap(videoInfo?.title || 'No title', 45)}](${primaryVideoLink})` : 'No video link'}**`,
      false,
    )
    .setTimestamp();

  hook
    .send(embed)
    .then(() => {
      return;
    })
    .catch(error => {
      logger.error('Error sending webhook:', error);
      return;
    });
  return embed;
}

export async function passSubmissionHook(
  pass: PassSubmission,
  sanitizedJudgements: IJudgements,
) {
  if (!process.env.PASS_SUBMISSION_HOOK) {
    logger.warn('PASS_SUBMISSION_HOOK environment variable is not set, skipping webhook');
    return;
  }

  const hook = new Webhook(process.env.PASS_SUBMISSION_HOOK);
  hook.setUsername('TUF Pass Submissions');
  hook.setAvatar(botAvatar);
  if (!pass)
    return new MessageBuilder().setDescription('No pass info available');
  const level = pass.level;

  const submitter: User | null = pass.passSubmitter || null;
  const accuracy = calcAcc(sanitizedJudgements);

  const videoInfo = pass?.videoLink
    ? await getVideoDetails(pass.videoLink).then(details => details)
    : null;
  const primaryVideoLink = getPrimaryVideoLink(pass.videoLink);

  const levelLink = `${clientUrlEnv}/levels/${level?.id}`;

  const showAddInfo =
    pass.flags?.is12K || pass.flags?.is16K || pass.flags?.isNoHoldTap || pass.flags?.isAdofaiV2;
  const additionalInfo = (
    `${pass.flags?.is12K ? '12K  |  ' : ''}` +
    `${pass.flags?.is16K ? '16K  |  ' : ''}` +
    `${pass.flags?.isNoHoldTap ? 'Alt. Tap Option  |  ' : ''}` +
    `${pass.flags?.isAdofaiV2 ? 'ADOFAI v2  |  ' : ''}`
  ).replace(/\|\s*$/, '');
  const judgementLine = sanitizedJudgements
    ? `\`\`\`ansi\n[2;31m${sanitizedJudgements.earlyDouble}[0m [2;33m${sanitizedJudgements.earlySingle}[0m [2;32m${sanitizedJudgements.ePerfect}[0m [1;32m${sanitizedJudgements.perfect}[0m [2;32m${sanitizedJudgements.lPerfect}[0m [2;33m${sanitizedJudgements.lateSingle}[0m [2;31m${sanitizedJudgements.lateDouble}[0m\n\`\`\`\n`
    : '';

  const team = level?.team ? `Level by ${level?.team}` : null;
  const credit = `Chart by ${trim(formatCredits(level?.charters), 25)}${level?.vfxer ? ` | VFX by ${trim(formatCredits(level?.vfxers), 25)}` : ''}`;

  const discordId = submitter?.providers?.find(provider => provider.provider === 'discord')?.providerId || null;

  const embed = new MessageBuilder()
    .setAuthor(
      `${trim(level?.song || 'Unknown Song', 27)}${pass.speed !== 1 ? ` (${pass.speed}x)` : ''} - ${trim(level?.artist || 'Unknown Artist', 30)}`,
      level?.difficulty?.icon || '',
      levelLink,
    )
    .setTitle(
      `New clear submission from ${submitter?.player?.name || 'Unknown Player'}`,
    )
    .setColor('#000000')
    .setThumbnail(
      submitter?.avatarUrl || '',
    )
    .addField('', '', false)
    .addField('Player', `**${pass.passer || 'Unknown Player'}**`, true)
    .addField(
      'Submitter',
      `**${discordId ? `<@${discordId}>` : submitter?.username || 'Unknown Player'}** #${submitter?.playerId}`,
      true,
    )
    .addField('', '', false)

    .addField('Feeling Rating', `**${pass.feelingDifficulty || 'None'}**`, true)
    .addField('Accuracy', `**${((accuracy || 0.95) * 100).toFixed(2)}%**`, true)
    //.addField('Score', `**${formatNumber(score || 0)}**`, true)
    .addField('', '', false)

    .addField('Speed', `**${pass.speed || 'Unknown Speed'}**`, false)

    //.addField('<:1384060:1317995999355994112>', `**[Go to video](${pass.videoLink})**`, true)
    .addField('', judgementLine, false)
    .addField(showAddInfo ? additionalInfo : '', '', false)
    .addField(
      '',
      `**${primaryVideoLink ? `[${videoInfo?.title || 'No title'}](${primaryVideoLink})` : 'No video link'}**`,
      true,
    )
    //.setImage(videoInfo?.image || "")
    .setFooter(team || credit, '')
    .setTimestamp();
  hook
    .send(embed)
    .then(() => {
      return;
    })
    .catch(error => {
      logger.error('Error sending webhook:', error);
      return;
    });
  return embed;
}

async function rejectIfDiscordWebhookBlocked(
  res: Response,
): Promise<Response | null> {
  const remainingMs = await DiscordWebhookGate.getBlockedRemainingMs();
  if (remainingMs <= 0) return null;

  const blockedUntil = Date.now() + remainingMs;
  return res.status(429).json({
    error: 'Discord webhooks are temporarily blocked',
    code: 'DISCORD_WEBHOOK_BLOCKED',
    retryAfterMs: remainingMs,
    blockedUntil,
  });
}

async function buildPassLabels(passIds: number[]): Promise<Map<number, string>> {
  const labels = new Map<number, string>();
  if (passIds.length === 0) return labels;
  const passes = await Pass.findAll({
    where: { id: { [Op.in]: passIds } },
    include: [
      { model: Level, as: 'level', attributes: ['song', 'artist'] },
      { model: Player, as: 'player', attributes: ['name'] },
    ],
  });
  for (const pass of passes) {
    const song = pass.level?.song || 'Unknown';
    const player = pass.player?.name || 'Unknown';
    labels.set(pass.id, `${song} — ${player}`);
  }
  return labels;
}

async function buildQueueRowLabels(queueRowIds: number[]): Promise<Map<number, string>> {
  const labels = new Map<number, string>();
  if (queueRowIds.length === 0) return labels;
  const rows = await LevelAnnouncementQueue.findAll({
    where: { id: { [Op.in]: queueRowIds } },
    include: [{ model: Level, as: 'level', attributes: ['song', 'artist'] }],
  });
  for (const row of rows) {
    const song = row.level?.song || 'Unknown';
    const artist = row.level?.artist || '';
    labels.set(row.id, artist ? `${song} — ${artist}` : song);
  }
  return labels;
}

function announceResponse(job: Awaited<ReturnType<typeof AnnouncementJobService.createOrMergeRequest>>) {
  return {
    success: true,
    message: job.addedItemCount > 0 ? 'Webhook queued' : 'Nothing new to send',
    requestId: job.requestId,
    kind: job.kind,
    itemCount: job.itemCount,
    addedItemCount: job.addedItemCount,
    nothingToSend: job.addedItemCount === 0,
  };
}

router.get(
  '/announcement-jobs',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'getWebhookAnnouncementJobs',
    summary: 'Get announcement job snapshot',
    description: 'Open and recent announcement request trees for a kind. Super admin.',
    tags: ['Webhooks'],
    security: ['bearerAuth'],
    responses: { 200: { description: 'Snapshot' }, ...standardErrorResponses400500 },
  }),
  async (req: Request, res: Response) => {
    try {
      const kind = String(req.query.kind || '');
      if (kind !== 'pass' && kind !== 'level' && kind !== 'rerate') {
        return res.status(400).json({ error: 'kind must be pass, level, or rerate' });
      }
      const snapshot = await AnnouncementJobService.getSnapshot(kind);
      return res.json(snapshot);
    } catch (error) {
      logger.error('Error fetching announcement jobs:', error);
      return res.status(500).json({
        error: 'Failed to fetch announcement jobs',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

router.post(
  '/passes',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'postWebhooksPasses',
    summary: 'Send pass webhooks',
    description: 'Send Discord webhook announcements for passes. Body: passIds (array). Super admin.',
    tags: ['Webhooks'],
    security: ['bearerAuth'],
    requestBody: docRequestBody('passIds', passIdsBodySchema),
    responses: { 200: { description: 'Webhooks sent' }, ...standardErrorResponses400500 },
  }),
  async (req: Request, res: Response) => {
    try {
      const blocked = await rejectIfDiscordWebhookBlocked(res);
      if (blocked) return blocked;

      const {passIds} = req.body;

      if (!Array.isArray(passIds)) {
        return res.status(400).json({error: 'passIds must be an array'});
      }

      const sorted = [...passIds].sort((a, b) => a - b);
      const labelsByItemId = await buildPassLabels(sorted);
      const job = await AnnouncementJobService.createOrMergeRequest({
        kind: 'pass',
        itemIds: sorted,
        labelsByItemId,
        user: {
          id: String(req.user?.id || ''),
          username: req.user?.username,
          nickname: req.user?.nickname,
        },
      });

      if (job.addedItemIds.length > 0) {
        const nonce = crypto.randomUUID();
        await OutboxService.emit(OUTBOX_EVENT_TYPES.DiscordPassBatchAnnouncement, {
          aggregate: 'pass_webhook',
          aggregateId: nonce,
          dedupKey: null,
          payload: { passIds: job.addedItemIds },
        });
      }

      return res.json(announceResponse(job));
    } catch (error) {
      logger.error('Error sending webhook:', error);
      return res.status(500).json({
        error: 'Failed to send webhook',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  }
);

router.post(
  '/levels',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'postWebhooksLevels',
    summary: 'Send level webhooks',
    description: 'Send Discord webhook announcements for new levels. Body: queueRowIds (array). Super admin.',
    tags: ['Webhooks'],
    security: ['bearerAuth'],
    requestBody: docRequestBody('queueRowIds', queueRowIdsBodySchema),
    responses: { 200: { description: 'Webhooks sent' }, ...standardErrorResponses400500 },
  }),
  async (req: Request, res: Response) => {
    try {
      const blocked = await rejectIfDiscordWebhookBlocked(res);
      if (blocked) return blocked;

      const {queueRowIds} = req.body;

      if (!Array.isArray(queueRowIds)) {
        return res.status(400).json({error: 'queueRowIds must be an array'});
      }

      const sorted = [...queueRowIds].sort((a, b) => a - b);
      const labelsByItemId = await buildQueueRowLabels(sorted);
      const job = await AnnouncementJobService.createOrMergeRequest({
        kind: 'level',
        itemIds: sorted,
        labelsByItemId,
        user: {
          id: String(req.user?.id || ''),
          username: req.user?.username,
          nickname: req.user?.nickname,
        },
      });

      if (job.addedItemIds.length > 0) {
        const nonce = crypto.randomUUID();
        await OutboxService.emit(OUTBOX_EVENT_TYPES.DiscordLevelBatchAnnouncement, {
          aggregate: 'level_webhook',
          aggregateId: nonce,
          dedupKey: null,
          payload: { queueRowIds: job.addedItemIds },
        });
      }

      return res.json(announceResponse(job));
    } catch (error) {
      logger.error('Error sending webhook:', error);
      return res.status(500).json({
        error: 'Failed to send webhook',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  }
);

router.post(
  '/rerates',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'postWebhooksRerates',
    summary: 'Send rerate webhooks',
    description: 'Send Discord webhook announcements for rerated levels. Body: queueRowIds (array). Uses RERATE_ANNOUNCEMENT_HOOK. Super admin.',
    tags: ['Webhooks'],
    security: ['bearerAuth'],
    requestBody: docRequestBody('queueRowIds', queueRowIdsBodySchema),
    responses: { 200: { description: 'Webhooks sent' }, ...standardErrorResponses400500 },
  }),
  async (req: Request, res: Response) => {
    try {
      const blocked = await rejectIfDiscordWebhookBlocked(res);
      if (blocked) return blocked;

      const {queueRowIds} = req.body;

      if (!Array.isArray(queueRowIds)) {
        return res.status(400).json({error: 'queueRowIds must be an array'});
      }

      const sorted = [...queueRowIds].sort((a, b) => a - b);
      const labelsByItemId = await buildQueueRowLabels(sorted);
      const job = await AnnouncementJobService.createOrMergeRequest({
        kind: 'rerate',
        itemIds: sorted,
        labelsByItemId,
        user: {
          id: String(req.user?.id || ''),
          username: req.user?.username,
          nickname: req.user?.nickname,
        },
      });

      if (job.addedItemIds.length > 0) {
        const nonce = crypto.randomUUID();
        await OutboxService.emit(OUTBOX_EVENT_TYPES.DiscordRerateBatchAnnouncement, {
          aggregate: 'rerate_webhook',
          aggregateId: nonce,
          dedupKey: null,
          payload: { queueRowIds: job.addedItemIds },
        });
      }

      return res.json(announceResponse(job));
    } catch (error) {
      logger.error('Error sending webhook:', error);
      return res.status(500).json({
        error: 'Failed to send webhook',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  }
);

router.post(
  '/silent-remove/passes',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'postWebhooksSilentRemovePasses',
    summary: 'Silent remove passes',
    description: 'Mark passes as announced without sending webhooks. Body: passIds (array). Super admin.',
    tags: ['Webhooks'],
    security: ['bearerAuth'],
    requestBody: docRequestBody('passIds', passIdsBodySchema),
    responses: { 200: { description: 'Passes marked' }, ...standardErrorResponses400500 },
  }),
  async (req: Request, res: Response) => {
    try {
      const {passIds} = req.body;

      if (!Array.isArray(passIds)) {
        return res.status(400).json({error: 'passIds must be an array'});
      }

      // Mark passes as announced without sending webhooks
      await Pass.update(
        { isAnnounced: true },
        { where: { id: { [Op.in]: passIds } } }
      );

      return res.json({success: true, message: 'Passes silently removed from announcement list'});
    } catch (error) {
      logger.error('Error silently removing passes:', error);
      return res.status(500).json({
        error: 'Failed to silently remove passes',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  }
);

router.post(
  '/silent-remove/levels',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'postWebhooksSilentRemoveLevels',
    summary: 'Silent remove levels',
    description: 'Mark new-level queue rows as skipped without sending webhooks. Body: queueRowIds (array). Super admin.',
    tags: ['Webhooks'],
    security: ['bearerAuth'],
    requestBody: docRequestBody('queueRowIds', queueRowIdsBodySchema),
    responses: { 200: { description: 'Levels marked' }, ...standardErrorResponses400500 },
  }),
  async (req: Request, res: Response) => {
    try {
      const {queueRowIds} = req.body;

      if (!Array.isArray(queueRowIds)) {
        return res.status(400).json({error: 'queueRowIds must be an array'});
      }

      await markQueueRowsSkipped(queueRowIds);

      return res.json({success: true, message: 'Levels silently removed from announcement list'});
    } catch (error) {
      logger.error('Error silently removing levels:', error);
      return res.status(500).json({
        error: 'Failed to silently remove levels',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  }
);

router.post(
  '/silent-remove/rerates',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'postWebhooksSilentRemoveRerates',
    summary: 'Silent remove rerates',
    description: 'Mark rerate queue rows as skipped without sending webhooks. Body: queueRowIds (array). Super admin.',
    tags: ['Webhooks'],
    security: ['bearerAuth'],
    requestBody: docRequestBody('queueRowIds', queueRowIdsBodySchema),
    responses: { 200: { description: 'Rerates marked' }, ...standardErrorResponses400500 },
  }),
  async (req: Request, res: Response) => {
    try {
      const {queueRowIds} = req.body;

      if (!Array.isArray(queueRowIds)) {
        return res.status(400).json({error: 'queueRowIds must be an array'});
      }

      await markQueueRowsSkipped(queueRowIds);

      return res.json({success: true, message: 'Rerates silently removed from announcement list'});
    } catch (error) {
      logger.error('Error silently removing rerates:', error);
      return res.status(500).json({
        error: 'Failed to silently remove rerates',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  }
);

export default router;

