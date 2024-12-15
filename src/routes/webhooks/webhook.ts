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

const passInfo = await Pass.findByPk(11082, {
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
  ],
});

function createClearEmbed(passInfo: Pass | null): MessageBuilder {
  if (!passInfo) return new MessageBuilder().setDescription('No pass info available');
  const pass = passInfo.dataValues;
  console.log(pass.level?.difficulty?.icon);
  const embed = new MessageBuilder()
    .setTitle('New Clear!')
    .setAuthor(
      pass.player?.name || 'Unknown Player',
      pass.level?.difficulty?.icon || '',
      ''
    )
    .setColor('#000000')
    .setThumbnail(
      pass.player?.discordAvatar ? 
      pass.player?.discordAvatar : 
      pass.player?.pfp && 
      pass.player?.pfp !== "none" ? 
      pass.player?.pfp : 
      placeHolder
    )
    .setDescription(
      `${pass.level?.artist || 'Unknown Artist'} - ${pass.level?.song || 'Unknown Song'}\n` +
      `${pass.vidLink || 'No video link'}\n\n` +
      `Player: ${pass.player?.discordId ? `<@${pass.player?.discordId}>` : pass.player?.name || 'Unknown Player'}\n\n` +
      `TUF Rating: ${pass.scoreV2 || 0}\n` +
      `Feeling Rating: ${pass.feelingRating || 'None'}\n\n` +
      'Accuracy\n' +
      `${((pass.accuracy || 0.95) * 100).toFixed(6)}%\n\n` +
      'Additional Info\n' +
      `${pass.isWorldsFirst ? '🏆 World\'s First!\n' : ''}` +
      `${pass.is12K ? '12K ' : ''}${pass.is16K ? '16K ' : ''}${pass.isNoHoldTap ? 'No Hold Tap ' : ''}`
    )
    .setFooter(
      `Mapped by ${pass.level?.charter || 'Unknown'} | VFX by ${pass.level?.vfxer || 'Unknown'}`, 
      placeHolder
    )
    .setTimestamp();

  return embed;
}

router.get('/testhook', async (req: Request, res: Response) => {
  try {
    const {CLEAR_ANNOUNCEMENT_HOOK} = process.env;
    if (!CLEAR_ANNOUNCEMENT_HOOK) {
      throw new Error('Webhook URL not configured');
    }

    const hook = new Webhook(CLEAR_ANNOUNCEMENT_HOOK);
    hook.setUsername('TUF Clear Announcer');
    hook.setAvatar(placeHolder);

    const embed = createClearEmbed(passInfo);
    await hook.send(embed);

    return res.json({ success: true, message: 'Webhook sent successfully' });
  } catch (error) {
    console.error('Error sending webhook:', error);
    return res.status(500).json({
      error: 'Failed to send webhook',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

router.get('/announcementTest', async (req: Request, res: Response) => {
  try {
    const {CLEAR_ANNOUNCEMENT_HOOK} = process.env;
    if (!CLEAR_ANNOUNCEMENT_HOOK) {
      throw new Error('Webhook URL not configured');
    }

    const hook = new Webhook(CLEAR_ANNOUNCEMENT_HOOK);
    hook.setUsername('TUF Clear Announcer');
    hook.setAvatar(placeHolder);

    const embed = createClearEmbed(passInfo);
    await hook.send(embed);

    return res.json({ success: true, message: 'Announcement sent successfully' });
  } catch (error) {
    console.error('Error sending announcement:', error);
    return res.status(500).json({
      error: 'Failed to send announcement',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

export default router;
