import express, {Request, Response, Router} from 'express';
import Pass from '../../models/Pass.js';
import Difficulty from '../../models/Difficulty.js';
import Level from '../../models/Level.js';
import {Webhook, MessageBuilder} from '../../webhook/index.js';
import Player from '../../models/Player.js';
import {Op} from 'sequelize';
import {
  createClearEmbed,
  createNewLevelEmbed,
  createRerateEmbed,
  formatString,
  trim,
  wrap,
} from './embeds.js';
import Judgement from '../../models/Judgement.js';
import {
  getPassAnnouncementConfig,
  getLevelAnnouncementConfig,
} from './channelParser.js';
import {PassSubmission} from '../../models/PassSubmission.js';
import {getVideoDetails} from '../../utils/videoDetailParser.js';
import LevelSubmission from '../../models/LevelSubmission.js';
import {calcAcc, IJudgements} from '../../misc/CalcAcc.js';
import {Auth} from '../../middleware/auth.js';

const router: Router = express.Router();

const clientUrlEnv =
  process.env.NODE_ENV === 'production'
    ? process.env.PROD_CLIENT_URL
    : process.env.NODE_ENV === 'staging'
      ? process.env.STAGING_CLIENT_URL
      : process.env.NODE_ENV === 'development'
        ? process.env.CLIENT_URL
        : 'http://localhost:5173';

const placeHolder = clientUrlEnv + '/v2/media/image/soggycat.png';

// Add logging helper at the top
function logWebhookEvent(type: string, details: Record<string, any>) {
  const timestamp = new Date().toISOString();
  console.log(JSON.stringify({
    timestamp,
    type: `webhook_${type}`,
    ...details
  }));
}

// Helper function to process items in batches
async function processBatches<T>(
  items: T[],
  batchSize: number,
  processor: (batch: T[], isFirstBatch: boolean) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const isFirstBatch = i === 0;
    await processor(batch, isFirstBatch);
    // Add a small delay between batches to avoid rate limiting
    if (i + batchSize < items.length) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

// Helper to send webhook messages for a specific webhook URL
async function sendWebhookMessages(
  webhookUrl: string,
  embeds: MessageBuilder[],
  ping?: string,
  isFirstBatch: boolean = false
) {
  const hook = new Webhook(webhookUrl);
  hook.setUsername('TUF Announcer');
  hook.setAvatar(placeHolder);

  const combinedEmbed = MessageBuilder.combine(...embeds);
  
  // Always set the ping if it exists, not just for the first batch
  if (ping) {
    combinedEmbed.setText(ping);
  }

  await hook.send(combinedEmbed);
}

// Helper to group passes/levels by webhook URL
interface WebhookGroup {
  webhookUrl: string;
  ping: string;
  items: (Pass | Level)[];
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
    .addField('', `<@${submitterDiscordId}>`, false)
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
      console.error('Error sending webhook:', error);
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
      `${trim(level?.song || 'Unknown Song', 27)} — ${trim(level?.artist || 'Unknown Artist', 30)}`,
      level?.difficulty?.icon || '',
      levelLink,
    )
    .setTitle(
      `New clear submission ${trim(pass.submitterDiscordUsername || 'Unknown Player', 25)}`,
    )
    .setColor('#000000')
    .setThumbnail(
      pass.submitterDiscordPfp ? pass.submitterDiscordPfp : placeHolder,
    )
    .addField('', '', false)
    .addField('Player', `**${pass.passer || 'Unknown Player'}**`, true)
    .addField(
      'Submitter',
      `**${pass.submitterDiscordId ? `<@${pass.submitterDiscordId}>` : pass.submitterDiscordUsername || 'Unknown Player'}**`,
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
      console.error('Error sending webhook:', error);
      return;
    });
  return embed;
}

function shouldAnnouncePass(pass: Pass): boolean {
  return (
    pass.level?.diffId !== 0 &&
    pass.level?.difficulty?.name !== '-2' &&
    pass.level?.difficulty?.name.startsWith('P') === false
  );
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
            include: [
              {
                model: Pass,
                as: 'passes',
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

      // Group passes by webhook URL
      const groups = groupByWebhook(passes, configs);

      // Process each webhook group
      for (const group of groups) {
        await processBatches(group.items, 10, async (batchPasses, isFirstBatch) => {
          const embeds = await Promise.all(
            batchPasses.map(pass => createClearEmbed(pass as Pass))
          );
          
          await sendWebhookMessages(
            group.webhookUrl,
            embeds,
            group.ping,
            isFirstBatch
          );
        });
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
      console.error('Error sending webhook:', error);
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
      }

      // Group levels by webhook URL
      const groups = groupByWebhook(levels, configs);

      // Process each webhook group
      for (const group of groups) {
        await processBatches(group.items, 10, async (batchLevels, isFirstBatch) => {
          const embeds = await Promise.all(
            batchLevels.map(level => createNewLevelEmbed(level as Level))
          );
          
          await sendWebhookMessages(
            group.webhookUrl,
            embeds,
            group.ping,
            isFirstBatch
          );
        });
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
      console.error('Error sending webhook:', error);
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
          {
            model: Difficulty,
            as: 'previousDifficulty',
          },
        ],
      });

      // Get announcement configs for all levels (with isRerate=true)
      const configs = new Map();
      for (const level of levels) {
        if (!level.diffId) continue;
        const config = await getLevelAnnouncementConfig(level, true);
        configs.set(level.id, config);
      }

      // Group levels by webhook URL
      const groups = groupByWebhook(levels, configs);

      // Process each webhook group
      for (const group of groups) {
        await processBatches(group.items, 10, async (batchLevels, isFirstBatch) => {
          const embeds = await Promise.all(
            batchLevels.map(level => createRerateEmbed(level as Level))
          );
          
          await sendWebhookMessages(
            group.webhookUrl,
            embeds,
            group.ping,
            isFirstBatch
          );
        });
      }

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
      console.error('Error sending webhook:', error);
      return res.status(500).json({
        error: 'Failed to send webhook',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

export default router;
