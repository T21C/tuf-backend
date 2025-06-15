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
} from './channelParser.js';
import {PassSubmission} from '../../models/submissions/PassSubmission.js';
import {getVideoDetails} from '../../utils/videoDetailParser.js';
import LevelSubmission from '../../models/submissions/LevelSubmission.js';
import {calcAcc, IJudgements} from '../../utils/CalcAcc.js';
import {Auth} from '../../middleware/auth.js';
import { logger } from '../../services/LoggerService.js';
import { clientUrlEnv } from '../../config/app.config.js';
import { User } from '../../models/index.js';

const router: Router = express.Router();

const placeHolder = clientUrlEnv + '/v2/media/image/soggycat.png';

// Add logging helper at the top
function logWebhookEvent(type: string, details: Record<string, any>) {
  if (process.env.NODE_ENV === 'development') {
    const timestamp = new Date().toISOString();
    logger.debug(JSON.stringify({
      timestamp,
      type: `webhook_${type}`,
      ...details
    }));
  }
}

// Helper to group passes/levels by webhook URL
interface WebhookGroup {
  webhookUrl: string;
  ping: string;
  items: (Pass | Level)[];
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
  
  // Process each group and collect messages
  for (const group of groups) {
    if (!channelMessages.has(group.webhookUrl)) {
      channelMessages.set(group.webhookUrl, {
        webhookUrl: group.webhookUrl,
        messages: []
      });
    }
    
    const channel = channelMessages.get(group.webhookUrl)!;
    
    // Process items in batches
    for (let i = 0; i < group.items.length; i += 10) {
      const batch = group.items.slice(i, i + 10);
      const embeds = await Promise.all(
        batch.map(item => {
          if ('level' in item) {
            return createClearEmbed(item as Pass);
          } else {
            return createNewLevelEmbed(item as Level);
          }
        })
      );
      
      // Check if this is an @everyone ping
      const isEveryonePing = group.ping === '@everyone';
      
      channel.messages.push({
        content: group.ping,
        embeds,
        isEveryonePing
      });
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
  
  return Array.from(channelMessages.values());
}

// Helper to send sorted messages for a channel
async function sendSortedMessages(channel: ChannelMessages): Promise<void> {
  const hook = new Webhook(channel.webhookUrl);
  hook.setUsername('TUF Announcer');
  hook.setAvatar(placeHolder);
  
  for (const message of channel.messages) {
    // Split embeds into batches of 8
    for (let i = 0; i < message.embeds.length; i += 8) {
      const embedBatch = message.embeds.slice(i, i + 8);
      const combinedEmbed = MessageBuilder.combine(...embedBatch);
      
      // Only add content text to first batch
      if (message.content && i === 0) {
        combinedEmbed.setText(message.content);
      }
      
      await hook.send(combinedEmbed);
      
      // Add a small delay between messages to avoid rate limiting
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
}

function groupByWebhook(items: (Pass | Level)[], configs: Map<number, AnnouncementConfig>): WebhookGroup[] {
  const groups = new Map<string, WebhookGroup>();

  for (const item of items) {
    const config = configs.get(item.id);
    if (!config) continue;

    // Process each webhook URL in the config
    Object.entries(config.webhooks).forEach(([channelLabel, webhookUrl]) => {
      const ping = config.pings[channelLabel] || '';
      const key = `${webhookUrl}:${ping}`;

      if (!groups.has(key)) {
        groups.set(key, {
          webhookUrl,
          ping,
          items: []
        });
      }
      groups.get(key)?.items.push(item);
    });
  }

  return Array.from(groups.values());
}

export async function levelSubmissionHook(levelSubmission: LevelSubmission) {
  const hook = new Webhook(process.env.LEVEL_SUBMISSION_HOOK);
  hook.setUsername('TUF Level Submission Hook');
  hook.setAvatar(placeHolder);

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
  const submitterDiscordPfp = level?.submitterDiscordPfp || null;
  const submitterDiscordId = level?.submitterDiscordId || null;
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

  const embed = new MessageBuilder()
    .setColor('#000000')
    .setAuthor('New level submission', submitterDiscordPfp || placeHolder, '')
    .setTitle(`${song || 'Unknown Song'} — ${artist || 'Unknown Artist'}`)
    .addField('', `${submitterDiscordId ? `<@${submitterDiscordId}>` : `@${submitter?.nickname}`} #${submitter?.playerId}`, false)
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
  passSubmission: PassSubmission,
  sanitizedJudgements: IJudgements,
) {
  const hook = new Webhook(process.env.PASS_SUBMISSION_HOOK);
  hook.setUsername('TUF Pass Submission Hook');
  hook.setAvatar(placeHolder);
  if (!passSubmission)
    return new MessageBuilder().setDescription('No pass info available');
  const pass = passSubmission.dataValues;
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
  const credit = `Chart by ${trim(level?.charter || 'Unknown', 25)}${level?.vfxer ? ` | VFX by ${trim(level?.vfxer || 'Unknown', 25)}` : ''}`;

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
      `**${pass.submitterDiscordId ? `<@${pass.submitterDiscordId}>` : pass.submitterDiscordUsername || submitter?.username || 'Unknown Player'}**`,
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
    const requestId = Math.random().toString(36).substring(7);
    logWebhookEvent('pass_request_received', {
      requestId,
      passCount: req.body.passIds?.length || 0
    });

    try {
      const {passIds} = req.body;

      if (!Array.isArray(passIds)) {
        logWebhookEvent('pass_request_error', {
          requestId,
          error: 'Invalid input: passIds must be an array'
        });
        return res.status(400).json({error: 'passIds must be an array'});
      }

      // Load all passes with their configs
      const passes = await Pass.findAll({
        where: {id: {[Op.in]: passIds}},
        include: [
          {
            model: Level,
            as: 'level',
            include: [
              {
                model: Difficulty,
                as: 'difficulty',
              },
            ],
          },
          {
            model: Player,
            as: 'player',
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

      // Group passes by webhook URL
      const groups = groupByWebhook(passes, configs);
      
      // Collect and sort messages by channel
      const sortedChannels = await collectAndSortMessages(groups);
      
      // Send sorted messages for each channel
      for (const channel of sortedChannels) {
        await sendSortedMessages(channel);
      }

      logWebhookEvent('pass_request_complete', {
        requestId,
        status: 'success'
      });

      return res.json({success: true, message: 'Webhooks sent successfully'});
    } catch (error) {
      logWebhookEvent('pass_request_error', {
        requestId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
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
    const requestId = Math.random().toString(36).substring(7);
    logWebhookEvent('level_request_received', {
      requestId,
      levelCount: req.body.levelIds?.length || 0
    });

    try {
      const {levelIds} = req.body;

      if (!Array.isArray(levelIds)) {
        logWebhookEvent('level_request_error', {
          requestId,
          error: 'Invalid input: levelIds must be an array'
        });
        return res.status(400).json({error: 'levelIds must be an array'});
      }

      // Load all levels with their configs
      const levels = await Level.findAll({
        where: {
          id: {
            [Op.in]: levelIds,
          },
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
        
        // Log config details
        logWebhookEvent('level_config_loaded', {
          requestId,
          levelId: level.id,
          webhookCount: Object.keys(config.webhooks).length,
          webhookChannels: Object.keys(config.webhooks)
        });
      }

      // Group levels by webhook URL
      const groups = groupByWebhook(levels, configs);

      // Log group details
      logWebhookEvent('level_groups_created', {
        requestId,
        groupCount: groups.length,
        groupDetails: groups.map(g => ({
          webhookUrl: g.webhookUrl,
          itemCount: g.items.length,
          items: g.items.map(i => i.id)
        }))
      });
      
      // Collect and sort messages by channel
      const sortedChannels = await collectAndSortMessages(groups);
      
      // Send sorted messages for each channel
      for (const channel of sortedChannels) {
        await sendSortedMessages(channel);
      }

      logWebhookEvent('level_request_complete', {
        requestId,
        status: 'success'
      });

      return res.json({success: true, message: 'Webhooks sent successfully'});
    } catch (error) {
      logWebhookEvent('level_request_error', {
        requestId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
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
    const requestId = Math.random().toString(36).substring(7);
    logWebhookEvent('rerate_request_received', {
      requestId,
      levelCount: req.body.levelIds?.length || 0
    });

    try {
      const {levelIds} = req.body;

      if (!Array.isArray(levelIds)) {
        logWebhookEvent('rerate_request_error', {
          requestId,
          error: 'Invalid input: levelIds must be an array'
        });
        return res.status(400).json({error: 'levelIds must be an array'});
      }

      // Load all levels with their configs
      const rawLevels = await Level.findAll({
        where: {
          id: {
            [Op.in]: levelIds,
          },
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

      logWebhookEvent('rerate_levels_loaded', {
        requestId,
        levelCount: levels.length,
        levelIds: levels.map(l => l.id)
      });

      // Create a single channel for rerates
      const rerateChannel: ChannelMessages = {
        webhookUrl: process.env.RERATE_ANNOUNCEMENT_HOOK || "",
        messages: []
      };
      
      // Process levels in batches
      for (let i = 0; i < levels.length; i += 10) {
        const batchLevels = levels.slice(i, i + 10);
        const isFirstBatch = i === 0;
        
        logWebhookEvent('rerate_batch_processing', {
          requestId,
          batchNumber: isFirstBatch ? 1 : 'subsequent',
          batchSize: batchLevels.length
        });

        const embeds = await Promise.all(
          batchLevels.map(level => createRerateEmbed(level as Level))
        );
        
        // Check if this is an @everyone ping
        const ping = `<@&${process.env.RERATE_PING_ROLE_ID || "0"}>`;
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

      logWebhookEvent('rerate_request_complete', {
        requestId,
        status: 'success'
      });

      return res.json({success: true, message: 'Webhooks sent successfully'});
    } catch (error) {
      logWebhookEvent('rerate_request_error', {
        requestId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      logger.error('Error sending webhook:', error);
      return res.status(500).json({
        error: 'Failed to send webhook',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

export default router;
