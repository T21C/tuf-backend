import express, {Request, Response, Router} from 'express';
import Pass from '../../../models/passes/Pass.js';
import Difficulty from '../../../models/levels/Difficulty.js';
import Level from '../../../models/levels/Level.js';
import {Webhook, MessageBuilder} from '../../../webhook/index.js';
import Player from '../../../models/players/Player.js';
import {Op} from 'sequelize';
import {
  createClearEmbed,
  createNewLevelEmbed,
  createRerateEmbed,
  formatString,
  trim,
  wrap,
} from './embeds.js';
import Judgement from '../../../models/passes/Judgement.js';
import {
  getPassAnnouncementConfig,
  getLevelAnnouncementConfig,
  AnnouncementConfig,
  AnnouncementChannelConfig,
} from './channelParser.js';
import {PassSubmission} from '../../../models/submissions/PassSubmission.js';
import {getVideoDetails} from '../../../utils/data/videoDetailParser.js';
import LevelSubmission from '../../../models/submissions/LevelSubmission.js';
import {calcAcc, IJudgements} from '../../../utils/pass/CalcAcc.js';
import {Auth} from '../../middleware/auth.js';
import { logger } from '../../services/LoggerService.js';
import { clientUrlEnv } from '../../../config/app.config.js';
import { User } from '../../../models/index.js';
import { formatCredits } from '../../../utils/Utility.js';
import Creator from '../../../models/credits/Creator.js';
import LevelCredit from '../../../models/levels/LevelCredit.js';
import Team from '../../../models/credits/Team.js';
import { env } from 'process';

const router: Router = express.Router();

const placeHolder = 'https://soggy.cat/static/ssoggycat/main/images/soggycat.webp';
const botAvatar = process.env.BOT_AVATAR_URL || placeHolder;

const UPDATE_AFTER_ANNOUNCEMENT = env.NODE_ENV === 'production';

// Interface for individual messages in a channel
interface ChannelMessage {
  type: 'text' | 'embeds';
  content?: string; // Plain text content (for headers or to add to embed batch)
  embeds?: MessageBuilder[]; // Embed batch (can have content added to first embed)
}

// Interface to track messages for each channel
interface ChannelMessages {
  webhookUrl: string;
  channelConfig: AnnouncementChannelConfig;
  messages: ChannelMessage[]; // Sequence of messages (headers + embed batches)
}

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

// Helper to create embed batch message with optional content
function createEmbedBatchMessage(embeds: MessageBuilder[], content?: string): ChannelMessage {
  return {
    type: 'embeds',
    embeds,
    ...(content && { content })
  };
}

// Process items and create embeds using channel list from configs
async function createChannelMessages(items: (Pass | Level)[], configs: Map<number, AnnouncementConfig>): Promise<ChannelMessages[]> {
  const channelMessages = new Map<string, ChannelMessages>();

  logger.debug(`[Message Processing] Processing ${items.length} item(s)`);

  logger.debug(`[Message Processing] Webhook configs:`, {configs: Array.from(configs.entries())});
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
      // Check if ANY format has {difficultyName}
      const hasAnyDifficultyNameFormat = data.channelConfig.messageFormats.some(
        f => f.messageFormat.includes('{difficultyName}')
      );

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
          // Create embeds for items that haven't been embedded yet
          const roleEmbeds: MessageBuilder[] = [];
          for (const item of itemsToEmbed) {
            if ('level' in item) {
              roleEmbeds.push(await createClearEmbed(item as Pass));
            } else {
              roleEmbeds.push(await createNewLevelEmbed(item as Level));
            }
            embeddedItems.add(item.id);
          }

          // Add header message to first embed batch
          for (let i = 0; i < roleEmbeds.length; i += 8) {
            const batch = roleEmbeds.slice(i, i + 8);
            messages.push(createEmbedBatchMessage(
              batch,
              i === 0 ? headerText : undefined // Add header to first batch only
            ));
          }
        } else {
          // All items already embedded, just send header as plain text
          messages.push({
            type: 'text',
            content: headerText
          });
        }
      }

      // Third: Send generic headers once before all embeds (if specific formats exist)
      // OR send generic headers with embeds (if no specific formats exist)
      if (hasAnyDifficultyNameFormat) {
        // Send generic headers as plain text before embeds
        for (const headerText of genericHeaders) {
          messages.unshift({
            type: 'text',
            content: headerText
          });
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
            const roleEmbeds: MessageBuilder[] = [];
            for (const item of itemsToEmbed) {
              if ('level' in item) {
                roleEmbeds.push(await createClearEmbed(item as Pass));
              } else {
                roleEmbeds.push(await createNewLevelEmbed(item as Level));
              }
              embeddedItems.add(item.id);
            }

            // Add header message to first embed batch
            for (let i = 0; i < roleEmbeds.length; i += 8) {
              const batch = roleEmbeds.slice(i, i + 8);
              messages.push(createEmbedBatchMessage(
                batch,
                i === 0 ? headerText : undefined // Add header to first batch only
              ));
            }
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
      const embeds: MessageBuilder[] = [];
      for (const item of data.items) {
        if ('level' in item) {
          embeds.push(await createClearEmbed(item as Pass));
        } else {
          embeds.push(await createNewLevelEmbed(item as Level));
        }
      }

      // Split embeds into batches of 8
      for (let i = 0; i < embeds.length; i += 8) {
        messages.push(createEmbedBatchMessage(embeds.slice(i, i + 8)));
      }
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

// Helper to send embeds for a channel
async function sendMessages(channel: ChannelMessages, message?: string): Promise<void> {
  const hook = new Webhook(channel.webhookUrl);
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
      
      await hook.send(combinedEmbed);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
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

router.post('/passes', Auth.superAdmin(), async (req: Request, res: Response) => {
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

      // Create channel messages using channel list from configs
      const channels = await createChannelMessages(passes, configs);

      // Send embeds for each channel
      for (const channel of channels) {
        await sendMessages(channel);
      }

      // Mark passes as announced after successful webhook sending
      if (UPDATE_AFTER_ANNOUNCEMENT) {
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

router.post('/levels', Auth.superAdmin(), async (req: Request, res: Response) => {
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

      // Create channel messages using channel list from configs
      const channels = await createChannelMessages(levels, configs);

      // Send embeds for each channel
      for (const channel of channels) {
        await sendMessages(channel);
      }

      // Mark levels as announced after successful webhook sending
      if (UPDATE_AFTER_ANNOUNCEMENT) {
        await Level.update(
          { isAnnounced: true },
          { where: { id: { [Op.in]: levelIds } } }
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

router.post('/rerates', Auth.superAdmin(), async (req: Request, res: Response) => {
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

      // Create embeds for rerates
      const embeds = await Promise.all(
        levels.map(level => createRerateEmbed(level as Level))
      );

      // Get ping role ID
      const pingRoleId = process.env.RERATE_PING_ROLE_ID || '';
      const ping = pingRoleId ? `<@&${pingRoleId}>` : undefined;

      // Create channel for rerates
      const rerateMessages: ChannelMessage[] = [];
      for (let i = 0; i < embeds.length; i += 8) {
        rerateMessages.push(createEmbedBatchMessage(
          embeds.slice(i, i + 8),
          i === 0 ? ping : undefined // Add ping to first batch
        ));
      }

      const rerateChannel: ChannelMessages = {
        webhookUrl: process.env.RERATE_ANNOUNCEMENT_HOOK || '',
        channelConfig: {
          label: 'rerates',
          webhookUrl: process.env.RERATE_ANNOUNCEMENT_HOOK || '',
          ping: ping
        },
        messages: rerateMessages
      };

      // Send embeds with ping on first batch
      await sendMessages(rerateChannel, ping);

      // Mark levels as announced after successful webhook sending
      if (UPDATE_AFTER_ANNOUNCEMENT) {
        await Level.update(
          { isAnnounced: true },
          { where: { id: { [Op.in]: levelIds } } }
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

