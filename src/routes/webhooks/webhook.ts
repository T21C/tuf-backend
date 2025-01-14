import express, {Request, Response, Router} from 'express';
import fetch from 'node-fetch';
import axios from 'axios';
import path from 'path';
import fs from 'fs';
import Pass from '../../models/Pass';
import Difficulty from '../../models/Difficulty';
import Level from '../../models/Level';
import {Webhook, MessageBuilder} from '../../webhook/index';
import Player from '../../models/Player.js';
import { Op } from 'sequelize';
import { createClearEmbed, createNewLevelEmbed, createRerateEmbed, formatNumber, formatString, trim, wrap} from './embeds';
import Judgement from '../../models/Judgement';
import { getPassAnnouncementConfig, getLevelAnnouncementConfig } from './channelParser';
import { PassSubmission, PassSubmissionFlags, PassSubmissionJudgements } from '../../models/PassSubmission';
import { getVideoDetails } from '../../utils/videoDetailParser';
import LevelSubmission from '../../models/LevelSubmission';
import { getScoreV2 } from '../../misc/CalcScore';
import { ILevel } from '../../interfaces/models';
import { IPassSubmission } from '../../interfaces/models';
import { calcAcc, IJudgements } from '../../misc/CalcAcc';
import { Auth } from '../../middleware/auth';

const router: Router = express.Router();

const placeHolder = process.env.OWN_URL + '/v2/media/image/soggycat.png';
// Helper function to process items in batches
async function processBatches<T>(
  items: T[],
  batchSize: number,
  processor: (batch: T[], isFirstBatch: boolean) => Promise<void>
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

export async function levelSubmissionHook(levelSubmission: LevelSubmission) {
  const hook = new Webhook(process.env.LEVEL_SUBMISSION_HOOK);
  hook.setUsername('TUF Level Submission Hook');
  hook.setAvatar(placeHolder);

  if (!levelSubmission) return new MessageBuilder().setDescription('No level info available');
  const level = levelSubmission.dataValues as LevelSubmission;

  const song = level?.song || null;
  const diff = level?.diff || null;
  const artist = level?.artist || null;
  const team = level?.team || null;
  const charter = level?.charter || null;
  const vfxer = level?.vfxer || null;
  const videoLink = level?.videoLink || null;
  const videoInfo = videoLink ? await getVideoDetails(videoLink).then(details => details) : null;
  const directDL = level?.directDL || null;
  const wsLink = level?.wsLink || null;
  const submitterDiscordUsername = level?.submitterDiscordUsername || null;
  const submitterDiscordPfp = level?.submitterDiscordPfp || null;
  const submitterDiscordId = level?.submitterDiscordId || null;


  const embed = new MessageBuilder()
      .setColor('#000000')
      .setAuthor(`New level submission`, submitterDiscordPfp || placeHolder, '')
    .setTitle(`${song || 'Unknown Song'} — ${artist || 'Unknown Artist'}`)
    //.setThumbnail(submitterDiscordPfp || placeHolder)
    .addField("", `<@${submitterDiscordId}>`, false)
    .addField('Suggested Difficulty', `**${diff || 'None'}**`, true)
    .addField("", "", false)
    
    if (team) embed
      .addField('', `Team\n**${formatString(team)}**`, true)
    if (vfxer) embed
      .addField('', `VFX\n**${formatString(vfxer)}**`, true);
    if (charter) embed
      .addField('', `Chart\n**${formatString(charter)}**`, true);
    
    embed.addField('', `**${videoLink ? `[${wrap(videoInfo?.title || 'No title', 45)}](${videoLink})` : 'No video link'}**`, false)
    /*.setFooter(
      team || credit, 
      ''
    )*/
    //.setImage(videoInfo?.image || "")
    .setTimestamp();



  hook.send(embed);
  return embed;
}

export async function passSubmissionHook(passSubmission: PassSubmission, sanitizedJudgements: IJudgements) {
  const hook = new Webhook(process.env.PASS_SUBMISSION_HOOK);
  hook.setUsername('TUF Pass Submission Hook');
  hook.setAvatar(placeHolder);
    if (!passSubmission) return new MessageBuilder().setDescription('No pass info available');
    const pass = passSubmission.dataValues;
    const level = pass.level;
    
    const accuracy = calcAcc(sanitizedJudgements)

    const videoInfo = pass?.videoLink ? await getVideoDetails(pass.videoLink).then(details => details) : null;

    const levelLink = `${process.env.CLIENT_URL}/levels/${level?.id}`;

    const showAddInfo = pass.flags?.is12K || pass.flags?.is16K || pass.flags?.isNoHoldTap;
    const additionalInfo = (
    `${pass.flags?.is12K ? '12K  |  ' : ''}` +
    `${pass.flags?.is16K ? '16K  |  ' : ''}` +
    `${pass.flags?.isNoHoldTap ? 'No Hold Tap  |  ' : ''}`
    ).replace(/\|\s*$/, '');
    const judgementLine = sanitizedJudgements ? 
      `\`\`\`ansi\n[2;31m${sanitizedJudgements.earlyDouble}[0m [2;33m${sanitizedJudgements.earlySingle}[0m [2;32m${sanitizedJudgements.ePerfect}[0m [1;32m${sanitizedJudgements.perfect}[0m [2;32m${sanitizedJudgements.lPerfect}[0m [2;33m${sanitizedJudgements.lateSingle}[0m [2;31m${sanitizedJudgements.lateDouble}[0m\n\`\`\`\n` : '';
    
      const team = level?.team ? `Level by ${level?.team}` : null;
      const credit = `Chart by ${trim(level?.charter || 'Unknown', 25)}${level?.vfxer ? ` | VFX by ${trim(level?.vfxer || 'Unknown', 25)}` : ''}`;

    const embed = new MessageBuilder()
      .setAuthor(
        `${trim(level?.song || 'Unknown Song', 27)} — ${trim(level?.artist || 'Unknown Artist', 30)}`,
        level?.difficulty?.icon || '',
        levelLink
      )
      .setTitle(`New clear submission ${trim(pass.submitterDiscordUsername || 'Unknown Player', 25)}`)
      .setColor('#000000')
      .setThumbnail(
        pass.submitterDiscordPfp ? 
        pass.submitterDiscordPfp : 
        placeHolder
      )
      .addField("", "", false)
      .addField('Player', `**${pass.passer || 'Unknown Player'}**`, true)
      .addField('Submitter', `**${pass.submitterDiscordId ? `<@${pass.submitterDiscordId}>` : pass.submitterDiscordUsername || 'Unknown Player'}**`, true)
      .addField("", "", false)

      .addField('Feeling Rating', `**${pass.feelingDifficulty || 'None'}**`, true)
      .addField('Accuracy', `**${((accuracy || 0.95) * 100).toFixed(2)}%**`, true)
      //.addField('Score', `**${formatNumber(score || 0)}**`, true)
      .addField("", "", false)

      
      .addField('Speed', `**${pass.speed || 'Unknown Speed'}**`, false)

      //.addField('<:1384060:1317995999355994112>', `**[Go to video](${pass.videoLink})**`, true)
      .addField('', judgementLine, false)
      .addField(showAddInfo ? additionalInfo : '', '', false)
      .addField('', `**${pass.videoLink ? `[${videoInfo?.title || 'No title'}](${pass.videoLink})` : 'No video link'}**`, true)
      //.setImage(videoInfo?.image || "")
      .setFooter(
        team || credit, 
        ''
      )
      .setTimestamp();
  hook.send(embed);
  return embed;
}


router.post('/passes', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    const { passIds } = req.body;
    
    if (!Array.isArray(passIds)) {
      return res.status(400).json({ error: 'passIds must be an array' });
    }

    const {WF_CLEAR_ANNOUNCEMENT_HOOK, PP_CLEAR_ANNOUNCEMENT_HOOK, UNIVERSAL_CLEAR_ANNOUNCEMENT_HOOK} = process.env;
    if (!WF_CLEAR_ANNOUNCEMENT_HOOK || !PP_CLEAR_ANNOUNCEMENT_HOOK || !UNIVERSAL_CLEAR_ANNOUNCEMENT_HOOK) {
      throw new Error('Webhook URL not configured');
    }

    const uClearHook = new Webhook(UNIVERSAL_CLEAR_ANNOUNCEMENT_HOOK);
    const wfClearHook = new Webhook(WF_CLEAR_ANNOUNCEMENT_HOOK);
    const ppClearHook = new Webhook(PP_CLEAR_ANNOUNCEMENT_HOOK);

    uClearHook.setUsername('TUF Clear Announcer');
    uClearHook.setAvatar(placeHolder);
    wfClearHook.setUsername('TUF Clear Announcer');
    wfClearHook.setAvatar(placeHolder);
    ppClearHook.setUsername('TUF Clear Announcer');
    ppClearHook.setAvatar(placeHolder);

    // Collect @everyone passes during batch processing
    let everyonePasses: Pass[] = [];

    // Process regular passes first
    await processBatches(passIds, 10, async (batchIds, isFirstBatch) => {
      const passes = await Pass.findAll({
        where: { id: { [Op.in]: batchIds } },
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
              }
            ]
          },
          {
            model: Judgement,
            as: 'judgements',
          }
        ],
      });

      // Group passes by their announcement config
      const universalPingPasses: Pass[] = [];
      const universalEveryonePasses: Pass[] = [];
      const wfPingPasses: Pass[] = [];
      const wfNoPingPasses: Pass[] = [];
      const ppPingPasses: Pass[] = [];
      const ppNoPingPasses: Pass[] = [];

      // Sort passes into their respective groups
      for (const pass of passes) {
        const config = getPassAnnouncementConfig(pass);
        if (config.channels.includes('universal-clears')) {
          if (config.pings['universal-clears'] === '@everyone') {
            universalEveryonePasses.push(pass);
          } else if (config.pings['universal-clears'] === '@universal ping') {
            universalPingPasses.push(pass);
          }
        }

        // Check WF clears
        if (config.channels.includes('wf-clears')) {
          if (config.pings['wf-clears'] === '@wf ping') {
            wfPingPasses.push(pass);
          } else {
            wfNoPingPasses.push(pass);
          }
        }

        // Check PP clears
        if (config.channels.includes('pp-clears')) {
          if (config.pings['pp-clears'] === '@pp ping') {
            ppPingPasses.push(pass);
          } else {
            ppNoPingPasses.push(pass);
          }
        }
      }

      // Send regular announcements first
      if (universalPingPasses.length > 0) {
        const embeds = await Promise.all(universalPingPasses.map(pass => createClearEmbed(pass)));
        const combinedEmbed = MessageBuilder.combine(...embeds);
        if (isFirstBatch) combinedEmbed.setText('<@&1041009420836016208>');
        await uClearHook.send(combinedEmbed);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      // Send WF and PP announcements
      if (wfPingPasses.length > 0) {
        const embeds = await Promise.all(wfPingPasses.map(pass => createClearEmbed(pass)));
        const combinedEmbed = MessageBuilder.combine(...embeds);
        if (isFirstBatch) combinedEmbed.setText('<@&1101885999212138557>');
        await wfClearHook.send(combinedEmbed);
      }

      if (wfNoPingPasses.length > 0) {
        const embeds = await Promise.all(wfNoPingPasses.map(pass => createClearEmbed(pass)));
        const combinedEmbed = MessageBuilder.combine(...embeds);
        if (isFirstBatch) combinedEmbed.setText('');
        await wfClearHook.send(combinedEmbed);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      // Send to PP channel
      if (ppPingPasses.length > 0) {
        const embeds = await Promise.all(ppPingPasses.map(pass => createClearEmbed(pass)));
        const combinedEmbed = MessageBuilder.combine(...embeds);
        if (isFirstBatch) combinedEmbed.setText('<@&1268895982352072769>');
        await ppClearHook.send(combinedEmbed);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      if (ppNoPingPasses.length > 0) {
        const embeds = await Promise.all(ppNoPingPasses.map(pass => createClearEmbed(pass)));
        const combinedEmbed = MessageBuilder.combine(...embeds);
        if (isFirstBatch) combinedEmbed.setText('');
        await ppClearHook.send(combinedEmbed);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      // Store @everyone passes
      const batchEveryonePasses = passes.filter(pass => {
        const config = getPassAnnouncementConfig(pass);
        return config.channels.includes('universal-clears') && 
               config.pings['universal-clears'] === '@everyone';
      });
      everyonePasses = everyonePasses.concat(batchEveryonePasses);
    });

    // Process collected @everyone passes last
    if (everyonePasses.length > 0) {
      await processBatches(everyonePasses.map(p => p.id), 10, async (batchIds, isFirstBatch) => {
        const passes = await Pass.findAll({
          where: { id: { [Op.in]: batchIds } },
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
                }
              ]
            },
            {
              model: Judgement,
              as: 'judgements',
            }
          ],
        });

        const embeds = await Promise.all(passes.map(pass => createClearEmbed(pass)));
        const combinedEmbed = MessageBuilder.combine(...embeds);
        if (isFirstBatch) combinedEmbed.setText('@everyone');
        await uClearHook.send(combinedEmbed);
        await new Promise(resolve => setTimeout(resolve, 1000)); // Longer delay for @everyone pings
      });
    }

    return res.json({ success: true, message: 'Webhooks sent successfully' });
  } catch (error) {
    console.error('Error sending webhook:', error);
    return res.status(500).json({
      error: 'Failed to send webhook',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

router.post('/levels', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    const { levelIds } = req.body;
    
    if (!Array.isArray(levelIds)) {
      return res.status(400).json({ error: 'levelIds must be an array' });
    }

    const {
      PLANETARY_LEVEL_ANNOUNCEMENT_HOOK,
      GALACTIC_LEVEL_ANNOUNCEMENT_HOOK,
      UNIVERSAL_LEVEL_ANNOUNCEMENT_HOOK,
      CENSORED_LEVEL_ANNOUNCEMENT_HOOK
    } = process.env;

    if (!PLANETARY_LEVEL_ANNOUNCEMENT_HOOK || !GALACTIC_LEVEL_ANNOUNCEMENT_HOOK || 
        !UNIVERSAL_LEVEL_ANNOUNCEMENT_HOOK || !CENSORED_LEVEL_ANNOUNCEMENT_HOOK) {
      throw new Error('Webhook URLs not configured');
    }

    const planetaryHook = new Webhook(PLANETARY_LEVEL_ANNOUNCEMENT_HOOK);
    const galacticHook = new Webhook(GALACTIC_LEVEL_ANNOUNCEMENT_HOOK);
    const universalHook = new Webhook(UNIVERSAL_LEVEL_ANNOUNCEMENT_HOOK);
    const censoredHook = new Webhook(CENSORED_LEVEL_ANNOUNCEMENT_HOOK);

    [planetaryHook, galacticHook, universalHook, censoredHook].forEach(hook => {
      hook.setUsername('TUF Level Announcer');
      hook.setAvatar(placeHolder);
    });

    // Process levels in batches of 10
    await processBatches(levelIds, 10, async (batchIds, isFirstBatch) => {
      const levels = await Level.findAll({
        where: {
          id: {
            [Op.in]: batchIds,
          }
        },
        include: [
          {
            model: Difficulty,
            as: 'difficulty',
          },
        ],
      });

      // Group levels by their announcement channels
      const planetaryLevels: Level[] = [];
      const galacticLevels: Level[] = [];
      const universalLevels: Level[] = [];
      const censoredLevels: Level[] = [];

      for (const level of levels) {
        const config = getLevelAnnouncementConfig(level);
        
        if (config.channels.includes('planetary-levels')) {
          planetaryLevels.push(level);
        } else if (config.channels.includes('galactic-levels')) {
          galacticLevels.push(level);
        } else if (config.channels.includes('censored-levels')) {
          censoredLevels.push(level);
        } else if (config.channels.includes('universal-levels')) {
          universalLevels.push(level);
        }
      }

      // Send to Planetary channel
      if (planetaryLevels.length > 0) {
        const embeds = await Promise.all(planetaryLevels.map(async (level) => await createNewLevelEmbed(level)));
        const combinedEmbed = MessageBuilder.combine(...embeds);
        if (isFirstBatch) {
          combinedEmbed.setText(`<@&${process.env.PLANETARY_PING_ROLE_ID}>`);
        }
        await planetaryHook.send(combinedEmbed);
      }

      // Send to Galactic channel
      if (galacticLevels.length > 0) {
        const embeds = await Promise.all(galacticLevels.map(async (level) => await createNewLevelEmbed(level)));
        const combinedEmbed = MessageBuilder.combine(...embeds);
        if (isFirstBatch) {
          combinedEmbed.setText(`<@&${process.env.GALACTIC_PING_ROLE_ID}>`);
        }
        await galacticHook.send(combinedEmbed);
      }

      // Send to Universal channel
      if (universalLevels.length > 0) {
        const embeds = await Promise.all(universalLevels.map(async (level) => await createNewLevelEmbed(level)));
        const combinedEmbed = MessageBuilder.combine(...embeds);
        if (isFirstBatch) {
          combinedEmbed.setText(`\n<@&${process.env.UNIVERSAL_PING_ROLE_ID}>`);
        }
        await universalHook.send(combinedEmbed);
      }

      // Send to Censored channel
      if (censoredLevels.length > 0) {
        const embeds = await Promise.all(censoredLevels.map(async (level) => await createNewLevelEmbed(level)));
        const combinedEmbed = MessageBuilder.combine(...embeds);
        if (isFirstBatch) {
          combinedEmbed.setText('');
        }
        await censoredHook.send(combinedEmbed);
      }
    });

    return res.json({ success: true, message: 'Webhooks sent successfully' });
  } catch (error) {
    console.error('Error sending webhook:', error);
    return res.status(500).json({
      error: 'Failed to send webhook',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

router.post('/rerates', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    const { levelIds } = req.body;
    
    if (!Array.isArray(levelIds)) {
      return res.status(400).json({ error: 'levelIds must be an array' });
    }

    const {RERATE_ANNOUNCEMENT_HOOK} = process.env;
    if (!RERATE_ANNOUNCEMENT_HOOK) {
      throw new Error('Webhook URL not configured');
    }

    const hook = new Webhook(RERATE_ANNOUNCEMENT_HOOK);
    hook.setUsername('TUF Level Announcer');
    hook.setAvatar(placeHolder);

    // Process rerates in batches of 10
    await processBatches(levelIds, 10, async (batchIds, isFirstBatch) => {
      const levels = await Level.findAll({
        where: {
          id: {
            [Op.in]: batchIds,
          }
        },
        include: [
          {
            model: Difficulty,
            as: 'difficulty',
          },
          {
            model: Difficulty,
            as: 'previousDifficulty',
          }
        ],
      });

      const embeds = await Promise.all(levels.map(level => createRerateEmbed(level)));
      const combinedEmbed = MessageBuilder.combine(...embeds);
      
      if (isFirstBatch) {
        // Get the appropriate ping based on the first level's difficulty
        const config = getLevelAnnouncementConfig(levels[0], true);
        const ping = config.pings['rerates'] || '';
        combinedEmbed.setText(`${ping}`);
      }
      
      await hook.send(combinedEmbed);
    });

    return res.json({ success: true, message: 'Webhooks sent successfully' });
  } catch (error) {
    console.error('Error sending webhook:', error);
    return res.status(500).json({
      error: 'Failed to send webhook',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

export default router;
