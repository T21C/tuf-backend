import express, {Request, Response, Router} from 'express';
import Pass from '../../models/passes/Pass.js';
import Difficulty from '../../models/levels/Difficulty.js';
import Level from '../../models/levels/Level.js';
import {Webhook, MessageBuilder} from '../../webhook/index.js';
import Player from '../../models/players/Player.js';
import {Op} from 'sequelize';
import {
  createClearEmbed,
  createNewLevelEmbed,
  createRerateEmbed,
  formatString,
  trim,
  wrap,
} from './embeds.js';
import Judgement from '../../models/passes/Judgement.js';
import {
  getPassAnnouncementConfig,
  getLevelAnnouncementConfig,
  MessageFormatConfig,
} from './channelParser.js';
import {PassSubmission} from '../../models/submissions/PassSubmission.js';
import {getVideoDetails} from '../../utils/data/videoDetailParser.js';
import LevelSubmission from '../../models/submissions/LevelSubmission.js';
import {calcAcc, IJudgements} from '../../utils/pass/CalcAcc.js';
import {Auth} from '../../middleware/auth.js';
import { logger } from '../../services/LoggerService.js';
import { clientUrlEnv } from '../../config/app.config.js';
import { User } from '../../models/index.js';
import { formatCredits } from '../../utils/Utility.js';
import Creator from '../../models/credits/Creator.js';
import LevelCredit from '../../models/levels/LevelCredit.js';
import Team from '../../models/credits/Team.js';
import { env } from 'process';

const router: Router = express.Router();

const placeHolder = 'https://soggy.cat/static/ssoggycat/main/images/soggycat.webp';
const botAvatar = process.env.BOT_AVATAR_URL || placeHolder;

const UPDATE_PASSES_AFTER_ANNOUNCEMENT = env.NODE_ENV === 'production';

// Helper to group passes/levels by webhook URL and roleIds
interface WebhookGroup {
  webhookUrl: string;
  ping: string; // Combined ping string from all roleIds
  items: (Pass | Level)[];
  messageFormat?: string; // First available message format template
  roleIds: number[]; // Sorted array of roleIds for this group
  messageFormats?: MessageFormatConfig[]; // All message formats for this group
  isPlainTextOnly?: boolean; // If true, send as plain text message only (no embeds)
}

// Interface for message format variables
interface MessageVariables {
  count: number;
  difficultyName?: string;
  ping: string;
  groupName?: string;
}

// Render message format template with variables
function renderMessageFormat(format: string, variables: MessageVariables): string {
  let result = format;

  // Replace variables in the format string
  result = result.replace(/\{count\}/g, String(variables.count));
  
  if (variables.difficultyName !== undefined) {
    result = result.replace(/\{difficultyName\}/g, variables.difficultyName);
  } else {
    // Remove {difficultyName} placeholder if not provided
    result = result.replace(/\{difficultyName\}/g, '');
  }

  result = result.replace(/\{ping\}/g, variables.ping || '');

  if (variables.groupName !== undefined) {
    result = result.replace(/\{groupName\}/g, variables.groupName);
  } else {
    // Remove {groupName} placeholder if not provided
    result = result.replace(/\{groupName\}/g, '');
  }

  // Clean up any extra spaces left after variable removal
  result = result.replace(/\s+/g, ' ').trim();

  return result;
}

// New interface to track messages for each channel
interface ChannelMessages {
  webhookUrl: string;
  messages: {
    content: string;
    embeds: MessageBuilder[];
    isEveryonePing: boolean;
  }[];
}

// Helper to collect and sort messages by channel
async function collectAndSortMessages(groups: WebhookGroup[]): Promise<ChannelMessages[]> {
  const channelMessages = new Map<string, ChannelMessages>();

  logger.debug(`[Message Collection] Processing ${groups.length} group(s) for message collection`);

  // Sort groups: @everyone pings last, others first
  const sortedGroups = [...groups].sort((a, b) => {
    const aIsEveryone = a.ping === '@everyone';
    const bIsEveryone = b.ping === '@everyone';
    if (aIsEveryone && !bIsEveryone) return 1;
    if (!aIsEveryone && bIsEveryone) return -1;
    return 0;
  });

  // Process each group and collect messages
  for (const group of sortedGroups) {
    if (!channelMessages.has(group.webhookUrl)) {
      channelMessages.set(group.webhookUrl, {
        webhookUrl: group.webhookUrl,
        messages: []
      });
    }

    const channel = channelMessages.get(group.webhookUrl)!;
    const isEveryonePing = group.ping === '@everyone';

    // If this is a plain text only group (common ping), send without embeds
    if (group.isPlainTextOnly) {
      let content: string = '';
      if (group.messageFormat) {
        // Render formatted message for grouped messages
        const count = group.items.length;
        // Get difficulty name from first item if available
        const firstItem = group.items[0];
        const difficultyName = ('level' in firstItem && firstItem.level?.difficulty?.name) 
          ? firstItem.level.difficulty.name 
          : undefined;
        const ping = group.ping || '';
        
        content = renderMessageFormat(group.messageFormat, {
          count,
          difficultyName,
          ping,
        });
      } else {
        // Use ping as content
        content = group.ping;
      }

      channel.messages.push({
        content,
        embeds: [], // No embeds for plain text only messages
        isEveryonePing
      });

      logger.debug(`[Message Collection] Added plain text message to channel: content="${content}", isEveryone=${isEveryonePing}`);
      continue;
    }

    // Process items in batches of 10
    for (let i = 0; i < group.items.length; i += 10) {
      const batch = group.items.slice(i, i + 10);
      
      // Create embeds for all items
      const embeds = await Promise.all(
        batch.map(item => {
          if ('level' in item) {
            return createClearEmbed(item as Pass);
          } else {
            return createNewLevelEmbed(item as Level);
          }
        })
      );

      // Generate message content (only on first batch)
      let content: string = '';
      if (i === 0) {
        if (group.messageFormat) {
          // Render formatted message for grouped messages
          const count = group.items.length;
          // Get difficulty name from first item if available
          const firstItem = group.items[0];
          const difficultyName = ('level' in firstItem && firstItem.level?.difficulty?.name) 
            ? firstItem.level.difficulty.name 
            : undefined;
          const ping = group.ping || '';
          
          content = renderMessageFormat(group.messageFormat, {
            count,
            difficultyName,
            ping,
          });
        } else {
          // Use ping as content for individual messages
          content = group.ping;
        }
      }

      channel.messages.push({
        content,
        embeds,
        isEveryonePing
      });

      logger.debug(`[Message Collection] Added message to channel: content="${content}", ${embeds.length} embed(s), isEveryone=${isEveryonePing}`);
    }
  }

  // Sort messages for each channel - @everyone pings go last
  for (const channel of channelMessages.values()) {
    channel.messages.sort((a, b) => {
      if (a.isEveryonePing && !b.isEveryonePing) return 1;
      if (!a.isEveryonePing && b.isEveryonePing) return -1;
      return 0;
    });
  }

  const finalChannels = Array.from(channelMessages.values());
  logger.debug(`[Message Collection] Final result: ${finalChannels.length} channel(s) with ${finalChannels.reduce((sum, ch) => sum + ch.messages.length, 0)} total message(s)`);
  
  for (const channel of finalChannels) {
    logger.debug(`[Message Collection] Channel ${channel.webhookUrl}: ${channel.messages.length} message(s)`);
  }

  return finalChannels;
}

// Helper to send sorted messages for a channel
async function sendSortedMessages(channel: ChannelMessages): Promise<void> {
  const hook = new Webhook(channel.webhookUrl);
  hook.setUsername('TUF Announcer');
  hook.setAvatar(botAvatar);

  for (const message of channel.messages) {
    // If message has no embeds, send as plain text
    if (message.embeds.length === 0 && message.content) {
      const plainTextMessage = new MessageBuilder().setText(message.content);
      await hook.send(plainTextMessage);
      await new Promise(resolve => setTimeout(resolve, 500));
      continue;
    }

    // If message has embeds, send them in batches
    if (message.embeds.length > 0) {
      for (let i = 0; i < message.embeds.length; i += 8) {
        const embedBatch = message.embeds.slice(i, i + 8);
        const combinedEmbed = MessageBuilder.combine(...embedBatch);

        // Add content text to first batch only
        if (message.content && i === 0) {
          combinedEmbed.setText(message.content);
        }

        await hook.send(combinedEmbed);
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } else if (message.content) {
      // Fallback: send plain text if no embeds but has content
      const plainTextMessage = new MessageBuilder().setText(message.content);
      await hook.send(plainTextMessage);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
}

interface AnnouncementConfig {
  webhooks: {
    [key: string]: string;
  };
  pings: {
    [key: string]: string;
  };
  directiveIds?: {
    [key: string]: number;
  };
  actionIds?: {
    [key: string]: number;
  };
  messageFormats?: {
    [key: string]: MessageFormatConfig[];
  };
}

interface PassActionMapping {
  actionId: number;
  directiveId: number;
  channelLabel: string;
  webhookUrl: string;
  messageFormats?: MessageFormatConfig[];
  ping?: string; // Legacy ping for non-formatted messages
}

// Map each pass to its matching action(s) with message format metadata
// Now handles multiple directives per pass
async function getPassActionMapping(
  passes: Pass[],
  configs: Map<number, AnnouncementConfig>
): Promise<Map<number, PassActionMapping[]>> {
  const mapping = new Map<number, PassActionMapping[]>();

  logger.debug(`[Pass Mapping] Processing ${passes.length} pass(es) for action mapping`);

  for (const pass of passes) {
    const config = configs.get(pass.id);
    logger.debug(`[Pass Mapping] Pass ${pass.id} config: ${JSON.stringify(config)}`);
    if (!config) {
      logger.debug(`[Pass Mapping] Pass ${pass.id} has no config, skipping`);
      continue;
    }

    const passMappings: PassActionMapping[] = [];

    // Process each channel in the config
    for (const [channelLabel, webhookUrl] of Object.entries(config.webhooks)) {
      const directiveIdsRaw = config.directiveIds?.[channelLabel];
      const actionIdsRaw = config.actionIds?.[channelLabel];
      const directiveIds = Array.isArray(directiveIdsRaw) ? directiveIdsRaw : (directiveIdsRaw ? [directiveIdsRaw] : []);
      const actionIds = Array.isArray(actionIdsRaw) ? actionIdsRaw : (actionIdsRaw ? [actionIdsRaw] : []);
      const messageFormats = config.messageFormats?.[channelLabel];
      const ping = config.pings[channelLabel] || '';

      logger.debug(`[Pass Mapping] Pass ${pass.id}, channel "${channelLabel}": ${directiveIds.length} directive(s), ${messageFormats?.length || 0} message format(s)`);

      // Create a mapping per directive/action combination
      // If we have message formats, use those (sorted by directive sortOrder)
      if (messageFormats && messageFormats.length > 0) {
        // Sort message formats by directive sortOrder to maintain order
        const sortedFormats = [...messageFormats].sort((a, b) => 
          (a.directiveSortOrder || 0) - (b.directiveSortOrder || 0)
        );

        // Group by directive to create separate mappings per directive
        const formatsByDirective = new Map<number, MessageFormatConfig[]>();
        for (const format of sortedFormats) {
          if (!formatsByDirective.has(format.directiveId)) {
            formatsByDirective.set(format.directiveId, []);
          }
          formatsByDirective.get(format.directiveId)!.push(format);
        }

        // Create one mapping per directive
        for (const [directiveId, formats] of formatsByDirective) {
          const actionId = formats[0]?.actionId || 0;
          passMappings.push({
            actionId,
            directiveId,
            channelLabel,
            webhookUrl,
            messageFormats: formats,
            ping: undefined, // Don't use legacy ping when we have message formats
          });
          logger.debug(`[Pass Mapping] Created mapping for pass ${pass.id}: directive ${directiveId}, channel "${channelLabel}", ${formats.length} format(s)`);
        }
      } else if (actionIds.length > 0 || directiveIds.length > 0) {
        // Legacy ping system - use first action/directive
        const actionId = actionIds[0] || 0;
        const directiveId = directiveIds[0] || 0;
        passMappings.push({
          actionId,
          directiveId,
          channelLabel,
          webhookUrl,
          ping,
        });
        logger.debug(`[Pass Mapping] Created legacy mapping for pass ${pass.id}: directive ${directiveId}, channel "${channelLabel}", ping: ${ping}`);
      }
    }

    if (passMappings.length > 0) {
      mapping.set(pass.id, passMappings);
      logger.debug(`[Pass Mapping] Pass ${pass.id} has ${passMappings.length} total mapping(s)`);
    }
  }

  logger.debug(`[Pass Mapping] Total passes with mappings: ${mapping.size}`);
  return mapping;
}

// Helper to get roleId from ping string
// Treat @everyone as a special roleId (use -1 as identifier)
function getRoleIdFromPing(ping: string): number {
  if (ping === '@everyone') return -1; // Special roleId for @everyone
  const match = ping.match(/<@&(\d+)>/);
  return match ? parseInt(match[1], 10) : 0;
}

function groupByWebhook(items: (Pass | Level)[], configs: Map<number, AnnouncementConfig>, passMapping?: Map<number, PassActionMapping[]>): WebhookGroup[] {
  const finalGroups: WebhookGroup[] = [];

  logger.debug(`[Grouping] Processing ${items.length} item(s) for grouping`);

  // Step 1: Build maps per webhook
  // Map: webhookUrl -> Map: passId -> roleIds[]
  // Map: webhookUrl -> Map: roleId -> MessageFormatConfig
  const webhookPassRoleMap = new Map<string, Map<number, number[]>>();
  const webhookRoleFormatMap = new Map<string, Map<number, MessageFormatConfig>>();
  const webhookLegacyItems = new Map<string, { items: (Pass | Level)[]; ping: string; roleId: number }[]>();

  for (const item of items) {
    if (!('level' in item)) {
      // This is a Level - handle separately with legacy ping system
      const config = configs.get(item.id);
      if (!config) continue;

      Object.entries(config.webhooks).forEach(([channelLabel, webhookUrl]) => {
        const ping = config.pings[channelLabel] || '';
        const roleId = ping === '@everyone' ? -1 : getRoleIdFromPing(ping);
        
        if (!webhookLegacyItems.has(webhookUrl)) {
          webhookLegacyItems.set(webhookUrl, []);
        }
        
        const legacyList = webhookLegacyItems.get(webhookUrl)!;
        const existing = legacyList.find(l => l.ping === ping);
        if (existing) {
          if (!existing.items.find(i => i.id === item.id)) {
            existing.items.push(item);
          }
        } else {
          legacyList.push({ items: [item], ping, roleId });
        }
      });
      continue;
    }

    // This is a Pass
    const pass = item as Pass;
    const mappings = passMapping?.get(pass.id);
    
    if (!mappings || mappings.length === 0) {
      // No mappings - use legacy ping system
      const config = configs.get(pass.id);
      if (!config) continue;

      Object.entries(config.webhooks).forEach(([channelLabel, webhookUrl]) => {
        const ping = config.pings[channelLabel] || '';
        const roleId = ping === '@everyone' ? -1 : getRoleIdFromPing(ping);
        
        if (!webhookLegacyItems.has(webhookUrl)) {
          webhookLegacyItems.set(webhookUrl, []);
        }
        
        const legacyList = webhookLegacyItems.get(webhookUrl)!;
        const existing = legacyList.find(l => l.ping === ping);
        if (existing) {
          if (!existing.items.find(i => i.id === pass.id)) {
            existing.items.push(pass);
          }
        } else {
          legacyList.push({ items: [pass], ping, roleId });
        }
      });
      continue;
    }

    // Group mappings by webhookUrl
    const webhookMappings = new Map<string, {
      messageFormats: MessageFormatConfig[];
      legacyPing?: string;
    }>();

    for (const mapping of mappings) {
      const webhookUrl = mapping.webhookUrl;
      
      if (!webhookMappings.has(webhookUrl)) {
        webhookMappings.set(webhookUrl, {
          messageFormats: [],
        });
      }

      const webhookData = webhookMappings.get(webhookUrl)!;

      if (!mapping.messageFormats || mapping.messageFormats.length === 0) {
        if (mapping.ping) {
          webhookData.legacyPing = mapping.ping;
        }
      } else {
        for (const msgFormat of mapping.messageFormats) {
          if (!webhookData.messageFormats.find(mf => 
            mf.roleId === msgFormat.roleId && 
            mf.actionId === msgFormat.actionId && 
            mf.directiveId === msgFormat.directiveId
          )) {
            webhookData.messageFormats.push(msgFormat);
          }
        }
      }
    }

    // Process each webhook for this pass
    for (const [webhookUrl, webhookData] of webhookMappings) {
      if (webhookData.legacyPing && webhookData.messageFormats.length === 0) {
        // Legacy ping only
        const roleId = webhookData.legacyPing === '@everyone' ? -1 : getRoleIdFromPing(webhookData.legacyPing);
        
        if (!webhookLegacyItems.has(webhookUrl)) {
          webhookLegacyItems.set(webhookUrl, []);
        }
        
        const legacyList = webhookLegacyItems.get(webhookUrl)!;
        const existing = legacyList.find(l => l.ping === webhookData.legacyPing);
        if (existing) {
          if (!existing.items.find(i => i.id === pass.id)) {
            existing.items.push(pass);
          }
        } else {
          legacyList.push({ items: [pass], ping: webhookData.legacyPing, roleId });
        }
        continue;
      }

      if (webhookData.messageFormats.length === 0) continue;

      // Initialize maps for this webhook
      if (!webhookPassRoleMap.has(webhookUrl)) {
        webhookPassRoleMap.set(webhookUrl, new Map());
        webhookRoleFormatMap.set(webhookUrl, new Map());
      }

      const passRoleMap = webhookPassRoleMap.get(webhookUrl)!;
      const roleFormatMap = webhookRoleFormatMap.get(webhookUrl)!;

      // Collect roleIds for this pass
      const roleIds: number[] = [];
      for (const msgFormat of webhookData.messageFormats) {
        const roleId = msgFormat.ping === '@everyone' ? -1 : getRoleIdFromPing(msgFormat.ping);
        roleIds.push(roleId);
        
        // Map roleId to its format (use first one found, sorted by directive sortOrder)
        if (!roleFormatMap.has(roleId)) {
          roleFormatMap.set(roleId, msgFormat);
        } else {
          // Keep the one with lower directive sortOrder
          const existing = roleFormatMap.get(roleId)!;
          if ((msgFormat.directiveSortOrder || 0) < (existing.directiveSortOrder || 0)) {
            roleFormatMap.set(roleId, msgFormat);
          }
        }
      }

      // Store pass -> roleIds mapping
      passRoleMap.set(pass.id, roleIds);
    }
  }

  // Step 2: Process each webhook to find shared roleIds and create groups
  for (const [webhookUrl, passRoleMap] of webhookPassRoleMap) {
    const roleFormatMap = webhookRoleFormatMap.get(webhookUrl)!;
    
    if (passRoleMap.size === 0) continue;

    // Find shared roleIds across all passes
    const allPassIds = Array.from(passRoleMap.keys());
    let sharedRoleIds: number[] = passRoleMap.get(allPassIds[0]) || [];
    
    for (let i = 1; i < allPassIds.length; i++) {
      const passRoleIds = passRoleMap.get(allPassIds[i]) || [];
      sharedRoleIds = sharedRoleIds.filter(roleId => passRoleIds.includes(roleId));
    }

    logger.debug(`[Grouping] Webhook ${webhookUrl}: ${allPassIds.length} pass(es), ${sharedRoleIds.length} shared roleId(s)`);

    // Check if all roleIds are shared (no non-shared roleIds for any pass)
    let allRolesAreShared = true;
    for (const passId of allPassIds) {
      const passRoleIds = passRoleMap.get(passId) || [];
      const nonSharedRoleIds = passRoleIds.filter(roleId => !sharedRoleIds.includes(roleId));
      if (nonSharedRoleIds.length > 0) {
        allRolesAreShared = false;
        break;
      }
    }

    // Step 3: Create plain text messages for each shared roleId
    for (const sharedRoleId of sharedRoleIds) {
      const format = roleFormatMap.get(sharedRoleId);
      if (!format) continue;

      // Collect all passes that have this shared roleId
      const passesWithRole: Pass[] = [];
      for (const passId of allPassIds) {
        const passRoleIds = passRoleMap.get(passId) || [];
        if (passRoleIds.includes(sharedRoleId)) {
          const pass = items.find(i => 'level' in i && i.id === passId) as Pass | undefined;
          if (pass) {
            passesWithRole.push(pass);
          }
        }
      }

      if (passesWithRole.length > 0) {
        finalGroups.push({
          webhookUrl,
          ping: format.ping,
          items: passesWithRole,
          messageFormat: format.messageFormat,
          roleIds: [sharedRoleId],
          messageFormats: [format],
          isPlainTextOnly: !allRolesAreShared, // Send as plain text only if not all roles are shared
        });
      }
    }

    // Step 4: Create embed groups with non-shared roleIds only
    // Group passes by their non-shared roleIds
    const embedGroups = new Map<string, {
      roleIds: number[];
      items: Pass[];
      pings: string[];
      messageFormats: MessageFormatConfig[];
    }>();

    for (const passId of allPassIds) {
      const pass = items.find(i => 'level' in i && i.id === passId) as Pass | undefined;
      if (!pass) continue;

      const passRoleIds = passRoleMap.get(passId) || [];
      // Remove shared roleIds
      const nonSharedRoleIds = passRoleIds.filter(roleId => !sharedRoleIds.includes(roleId));

      if (nonSharedRoleIds.length === 0) {
        // All roleIds were shared, skip (already handled by plain text messages)
        continue;
      }

      // Sort non-shared roleIds for consistent grouping
      const sortedNonSharedRoleIds = [...nonSharedRoleIds].sort((a, b) => a - b);
      const groupKey = sortedNonSharedRoleIds.join(',');

      if (!embedGroups.has(groupKey)) {
        const pings: string[] = [];
        const messageFormats: MessageFormatConfig[] = [];
        
        for (const roleId of sortedNonSharedRoleIds) {
          const format = roleFormatMap.get(roleId);
          if (format) {
            if (format.ping) {
              pings.push(format.ping);
            }
            messageFormats.push(format);
          }
        }

        embedGroups.set(groupKey, {
          roleIds: sortedNonSharedRoleIds,
          items: [],
          pings,
          messageFormats,
        });
      }

      const embedGroup = embedGroups.get(groupKey)!;
      if (!embedGroup.items.find(p => p.id === pass.id)) {
        embedGroup.items.push(pass);
      }
    }

    // Create WebhookGroups for embed groups
    for (const embedGroup of embedGroups.values()) {
      const combinedPing = embedGroup.pings.filter(p => p).join(' ');
      const sortedFormats = [...embedGroup.messageFormats].sort((a, b) => 
        (a.directiveSortOrder || 0) - (b.directiveSortOrder || 0)
      );
      const firstMessageFormat = sortedFormats[0]?.messageFormat;

      finalGroups.push({
        webhookUrl,
        ping: combinedPing,
        items: embedGroup.items,
        messageFormat: firstMessageFormat,
        roleIds: embedGroup.roleIds,
        messageFormats: embedGroup.messageFormats,
      });
    }
  }

  // Step 5: Add legacy groups
  for (const [webhookUrl, legacyList] of webhookLegacyItems) {
    for (const legacy of legacyList) {
      finalGroups.push({
        webhookUrl,
        ping: legacy.ping,
        items: legacy.items,
        roleIds: [legacy.roleId],
      });
    }
  }

  logger.debug(`[Grouping] Created ${finalGroups.length} final group(s)`);
  return finalGroups;
}

export async function levelSubmissionHook(levelSubmission: LevelSubmission) {
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
    .setTitle(`${song || 'Unknown Song'} — ${artist || 'Unknown Artist'}`)
    .addField('', `${discordId ? `<@${discordId}>` : `@${submitter?.nickname}`} #${submitter?.playerId}`, false)
    .addField('Suggested Difficulty', `**${diff || 'None'}**`, true)
    .addField('', '', false);

  if (teamName) embed.addField('', `Team\n**${formatString(teamName)}**`, true);
  if (vfxersString) embed.addField('', `VFX\n**${formatString(vfxersString)}**`, true);
  embed.addField('', `Chart\n**${formatString(chartersString)}**`, true);

  embed
    .addField(
      '',
      `**${videoLink ? `[${wrap(videoInfo?.title || 'No title', 45)}](${videoLink})` : 'No video link'}**`,
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

  const levelLink = `${clientUrlEnv}/levels/${level?.id}`;

  const showAddInfo =
    pass.flags?.is12K || pass.flags?.is16K || pass.flags?.isNoHoldTap;
  const additionalInfo = (
    `${pass.flags?.is12K ? '12K  |  ' : ''}` +
    `${pass.flags?.is16K ? '16K  |  ' : ''}` +
    `${pass.flags?.isNoHoldTap ? 'No Hold Tap  |  ' : ''}`
  ).replace(/\|\s*$/, '');
  const judgementLine = sanitizedJudgements
    ? `\`\`\`ansi\n[2;31m${sanitizedJudgements.earlyDouble}[0m [2;33m${sanitizedJudgements.earlySingle}[0m [2;32m${sanitizedJudgements.ePerfect}[0m [1;32m${sanitizedJudgements.perfect}[0m [2;32m${sanitizedJudgements.lPerfect}[0m [2;33m${sanitizedJudgements.lateSingle}[0m [2;31m${sanitizedJudgements.lateDouble}[0m\n\`\`\`\n`
    : '';

  const team = level?.team ? `Level by ${level?.team}` : null;
  const credit = `Chart by ${trim(formatCredits(level?.charters), 25)}${level?.vfxer ? ` | VFX by ${trim(formatCredits(level?.vfxers), 25)}` : ''}`;

  const discordId = submitter?.providers?.find(provider => provider.provider === 'discord')?.providerId || null;

  const embed = new MessageBuilder()
    .setAuthor(
      `${trim(level?.song || 'Unknown Song', 27)}${pass.speed !== 1 ? ` (${pass.speed}x)` : ''} — ${trim(level?.artist || 'Unknown Artist', 30)}`,
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
      `**${pass.videoLink ? `[${videoInfo?.title || 'No title'}](${pass.videoLink})` : 'No video link'}**`,
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

router.post(
  '/passes',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    try {
      const {passIds} = req.body;

      if (!Array.isArray(passIds)) {
        return res.status(400).json({error: 'passIds must be an array'});
      }

      // Load all passes with their configs
      const passes = await Pass.findAll({
        where: {id: {[Op.in]: passIds}, isAnnounced: false},
        include: [
          {
            model: Level,
            as: 'level',
            include: [
              {
                model: Difficulty,
                as: 'difficulty',
              },
              {
                model: LevelCredit,
                as: 'levelCredits',
                include: [{
                  model: Creator,
                  as: 'creator',
                }],
              },
              {
                model: Team,
                as: 'teamObject',
              },
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
                required: false
              },
            ],
          },
          {
            model: Judgement,
            as: 'judgements',
          },
        ],
      });

      // Get announcement configs for all passes
      const configs = new Map();
      for (const pass of passes) {
        if (!pass.level?.diffId) continue;
        const config = await getPassAnnouncementConfig(pass);
        configs.set(pass.id, config);
      }

      // Get pass-to-action mapping for grouping
      const passMapping = await getPassActionMapping(passes, configs);

      // Group passes by webhook URL
      const groups = groupByWebhook(passes, configs, passMapping);

      // Collect and sort messages by channel
      const sortedChannels = await collectAndSortMessages(groups);

      // Send sorted messages for each channel
      for (const channel of sortedChannels) {
        await sendSortedMessages(channel);
      }

      // Mark passes as announced after successful webhook sending
      if (UPDATE_PASSES_AFTER_ANNOUNCEMENT) {
        await Pass.update(
          { isAnnounced: true },
          { where: { id: { [Op.in]: passIds } } }
        );
      }

      return res.json({success: true, message: 'Webhooks sent successfully'});
    } catch (error) {
      logger.error('Error sending webhook:', error);
      return res.status(500).json({
        error: 'Failed to send webhook',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

router.post(
  '/levels',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    try {
      const {levelIds} = req.body;

      if (!Array.isArray(levelIds)) {
        return res.status(400).json({error: 'levelIds must be an array'});
      }

      // Load all levels with their configs
      const levels = await Level.findAll({
        where: {
          id: {
            [Op.in]: levelIds,
          },
          isAnnounced: false,
        },
        include: [
          {
            model: Difficulty,
            as: 'difficulty',
          },
        ],
      });

      // Get announcement configs for all levels
      const configs = new Map();
      for (const level of levels) {
        if (!level.diffId) continue;
        const config = await getLevelAnnouncementConfig(level);
        configs.set(level.id, config);
      }

      // Group levels by webhook URL
      const groups = groupByWebhook(levels, configs);

      // Collect and sort messages by channel
      const sortedChannels = await collectAndSortMessages(groups);

      // Send sorted messages for each channel
      for (const channel of sortedChannels) {
        await sendSortedMessages(channel);
      }

      // Mark levels as announced after successful webhook sending
      await Level.update(
        { isAnnounced: true },
        { where: { id: { [Op.in]: levelIds } } }
      );

      return res.json({success: true, message: 'Webhooks sent successfully'});
    } catch (error) {
      logger.error('Error sending webhook:', error);
      return res.status(500).json({
        error: 'Failed to send webhook',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

router.post(
  '/rerates',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    try {
      const {levelIds} = req.body;

      if (!Array.isArray(levelIds)) {
        return res.status(400).json({error: 'levelIds must be an array'});
      }

      // Load all levels with their configs
      const rawLevels = await Level.findAll({
        where: {
          id: {
            [Op.in]: levelIds,
          },
          isAnnounced: false,
        },
        include: [
          {
            model: Difficulty,
            as: 'difficulty',
          },
          {
            model: Difficulty,
            as: 'previousDifficulty',
          },
        ],
      });

      const levels = rawLevels.filter(
        level => {
          const previousBaseScore = level.previousBaseScore || level.previousDifficulty?.baseScore || 0;
          const currentBaseScore = level.baseScore || level.difficulty?.baseScore || 0;

          return previousBaseScore !== currentBaseScore
              || level.previousDiffId !== level.diffId;
        }
      );

      // Create a single channel for rerates
      const rerateChannel: ChannelMessages = {
        webhookUrl: process.env.RERATE_ANNOUNCEMENT_HOOK || '',
        messages: []
      };

      // Process levels in batches
      for (let i = 0; i < levels.length; i += 10) {
        const batchLevels = levels.slice(i, i + 10);

        const embeds = await Promise.all(
          batchLevels.map(level => createRerateEmbed(level as Level))
        );

        // Check if this is an @everyone ping
        const ping = `<@&${process.env.RERATE_PING_ROLE_ID || '0'}>`;
        const isEveryonePing = ping.includes('@everyone');

        rerateChannel.messages.push({
          content: ping,
          embeds,
          isEveryonePing
        });
      }

      // Sort messages - @everyone pings go last
      rerateChannel.messages.sort((a, b) => {
        if (a.isEveryonePing && !b.isEveryonePing) return 1;
        if (!a.isEveryonePing && b.isEveryonePing) return -1;
        return 0;
      });

      // Send sorted messages
      await sendSortedMessages(rerateChannel);

      // Mark levels as announced after successful webhook sending
      await Level.update(
        { isAnnounced: true },
        { where: { id: { [Op.in]: levelIds } } }
      );

      return res.json({success: true, message: 'Webhooks sent successfully'});
    } catch (error) {
      logger.error('Error sending webhook:', error);
      return res.status(500).json({
        error: 'Failed to send webhook',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

router.post(
  '/silent-remove/passes',
  Auth.superAdmin(),
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
  },
);

router.post(
  '/silent-remove/levels',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    try {
      const {levelIds} = req.body;

      if (!Array.isArray(levelIds)) {
        return res.status(400).json({error: 'levelIds must be an array'});
      }

      // Mark levels as announced without sending webhooks
      await Level.update(
        { isAnnounced: true },
        { where: { id: { [Op.in]: levelIds } } }
      );

      return res.json({success: true, message: 'Levels silently removed from announcement list'});
    } catch (error) {
      logger.error('Error silently removing levels:', error);
      return res.status(500).json({
        error: 'Failed to silently remove levels',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

router.post(
  '/silent-remove/rerates',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    try {
      const {levelIds} = req.body;

      if (!Array.isArray(levelIds)) {
        return res.status(400).json({error: 'levelIds must be an array'});
      }

      // Mark levels as announced without sending webhooks
      await Level.update(
        { isAnnounced: true },
        { where: { id: { [Op.in]: levelIds } } }
      );

      return res.json({success: true, message: 'Rerates silently removed from announcement list'});
    } catch (error) {
      logger.error('Error silently removing rerates:', error);
      return res.status(500).json({
        error: 'Failed to silently remove rerates',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

export default router;

