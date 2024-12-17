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
import { createClearEmbed, createNewLevelEmbed, createRerateEmbed} from './embeds';
import Judgement from '../../models/Judgement';
import { getAnnouncementConfig } from './channelParser';

const router: Router = express.Router();

const placeHolder = process.env.OWN_URL + '/v2/media/image/soggycat.png';

interface PassInfo {
  player: string;
  tufRating: string;
  feelingRating: string;
  accuracy: string;
  score: string;
  song: string;
  artist: string;
  link: string;
}

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

router.post('/testhook/passes', async (req: Request, res: Response) => {
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

    // Process passes in batches of 10
    await processBatches(passIds, 10, async (batchIds, isFirstBatch) => {
      const passes = await Pass.findAll({
        where: {
          id: {
            [Op.in]: batchIds,
          }
        },
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

      for (const pass of passes) {
        const config = getAnnouncementConfig(pass);
        
        // Check universal clears
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

      // Send to Universal channel
      if (universalPingPasses.length > 0) {
        const embeds = await Promise.all(universalPingPasses.map(pass => createClearEmbed(pass)));
        const combinedEmbed = MessageBuilder.combine(...embeds);
        if (isFirstBatch) combinedEmbed.setText('# New Universal clears! @universal ping');
        await uClearHook.send(combinedEmbed);
      }

      if (universalEveryonePasses.length > 0) {
        const embeds = await Promise.all(universalEveryonePasses.map(pass => createClearEmbed(pass)));
        const combinedEmbed = MessageBuilder.combine(...embeds);
        if (isFirstBatch) combinedEmbed.setText('# New Universal clears! @everyone');
        await uClearHook.send(combinedEmbed);
      }

      // Send to WF channel
      if (wfPingPasses.length > 0) {
        const embeds = await Promise.all(wfPingPasses.map(pass => createClearEmbed(pass)));
        const combinedEmbed = MessageBuilder.combine(...embeds);
        if (isFirstBatch) combinedEmbed.setText('# New World\'s First clears! @wf ping');
        await wfClearHook.send(combinedEmbed);
      }

      if (wfNoPingPasses.length > 0) {
        const embeds = await Promise.all(wfNoPingPasses.map(pass => createClearEmbed(pass)));
        const combinedEmbed = MessageBuilder.combine(...embeds);
        if (isFirstBatch) combinedEmbed.setText('# New World\'s First clears!');
        await wfClearHook.send(combinedEmbed);
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      // Send to PP channel
      if (ppPingPasses.length > 0) {
        const embeds = await Promise.all(ppPingPasses.map(pass => createClearEmbed(pass)));
        const combinedEmbed = MessageBuilder.combine(...embeds);
        if (isFirstBatch) combinedEmbed.setText('# New Pure Perfect clears! @pp ping');
        await ppClearHook.send(combinedEmbed);
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      if (ppNoPingPasses.length > 0) {
        const embeds = await Promise.all(ppNoPingPasses.map(pass => createClearEmbed(pass)));
        const combinedEmbed = MessageBuilder.combine(...embeds);
        if (isFirstBatch) combinedEmbed.setText('# New Pure Perfect clears!');
        await ppClearHook.send(combinedEmbed);
        await new Promise(resolve => setTimeout(resolve, 500));
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

router.post('/testhook/levels', async (req: Request, res: Response) => {
  try {
    const { levelIds } = req.body;
    
    if (!Array.isArray(levelIds)) {
      return res.status(400).json({ error: 'levelIds must be an array' });
    }

    const {LEVEL_ANNOUNCEMENT_HOOK} = process.env;
    if (!LEVEL_ANNOUNCEMENT_HOOK) {
      throw new Error('Webhook URL not configured');
    }

    const hook = new Webhook(LEVEL_ANNOUNCEMENT_HOOK);
    hook.setUsername('TUF Level Announcer');
    hook.setAvatar(placeHolder);

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

      const embeds = await Promise.all(levels.map(level => createNewLevelEmbed(level)));
      const combinedEmbed = MessageBuilder.combine(...embeds);
      if (isFirstBatch) {
        combinedEmbed.setText('# <:J_wow:1223816920592023552> New levels! <:J_wow:1223816920592023552>');
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

router.post('/testhook/rerates', async (req: Request, res: Response) => {
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
        combinedEmbed.setText('# <:J_wow:1223816920592023552> Level rerates! <:J_wow:1223816920592023552>');
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
