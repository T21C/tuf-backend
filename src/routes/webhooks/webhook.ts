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


router.get('/testhook/passes', async (req: Request, res: Response) => {
  try {
    const passes = await Pass.findAll({
      where: {
        id: {
          [Op.gt]: 11082,
          [Op.lt]: 11086
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
    const {CLEAR_ANNOUNCEMENT_HOOK} = process.env;
    if (!CLEAR_ANNOUNCEMENT_HOOK) {
      throw new Error('Webhook URL not configured');
    }

    const hook = new Webhook(CLEAR_ANNOUNCEMENT_HOOK);
    hook.setUsername('TUF Clear Announcer');
    hook.setAvatar(placeHolder);
    const embeds = passes.map(pass => createClearEmbed(pass));
    const combinedEmbed = MessageBuilder.combine(...embeds);
    combinedEmbed.setText('# New clears!');
    await hook.send(combinedEmbed);

    return res.json({ success: true, message: 'Webhook sent successfully' });
  } catch (error) {
    console.error('Error sending webhook:', error);
    return res.status(500).json({
      error: 'Failed to send webhook',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

router.get('/testhook/levels', async (req: Request, res: Response) => {
  try {
    
const levels = await Level.findAll({
  where: {
    id: {
      [Op.gte]: 7248,
      [Op.lte]: 7256
    }
  },
  include: [
    {
      model: Difficulty,
      as: 'difficulty',
    },
  ],
});
    const {CLEAR_ANNOUNCEMENT_HOOK} = process.env;
    if (!CLEAR_ANNOUNCEMENT_HOOK) {
      throw new Error('Webhook URL not configured');
    }

    const hook = new Webhook(CLEAR_ANNOUNCEMENT_HOOK);
    hook.setUsername('TUF Level Announcer');
    hook.setAvatar(placeHolder);
    const embeds = await Promise.all(levels.map(level => createNewLevelEmbed(level)));
    const combinedEmbed = MessageBuilder.combine(...embeds);
    combinedEmbed.setText('# <:J_wow:1223816920592023552> New levels! <:J_wow:1223816920592023552>');
    await hook.send(combinedEmbed);

    return res.json({ success: true, message: 'Webhook sent successfully' });
  } catch (error) {
    console.error('Error sending webhook:', error);
    return res.status(500).json({
      error: 'Failed to send webhook',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

export default router;
