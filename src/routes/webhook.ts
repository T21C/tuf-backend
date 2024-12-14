import express, {Request, Response, Router} from 'express';
import fetch from 'node-fetch';
import {loadPfpList} from '../utils/fileHandlers.js';
import axios from 'axios';
import path from 'path';
import fs from 'fs';
import {Webhook, MessageBuilder} from '../webhook/index';

const router: Router = express.Router();

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

function createClearEmbed(passInfo: PassInfo): MessageBuilder {
  const embed = new MessageBuilder()
    .setText('@everyone')
    .setAuthor(
      'sigma Webhook Node Author',
      process.env.OWN_URL + '/v2/media/image/fa.png',
      'https://npmjs.org/package/discord-webhook-node',
    )
    .setColor('#000000')
    .setThumbnail(process.env.OWN_URL + '/v2/media/image/fa.png')
    .addField('Field #1', 'Not inline', false)
    .setDescription(
      `${passInfo.artist} - ${passInfo.song}\n` +
        `${passInfo.link}\n\n` +
        `player: ${passInfo.player}\n\n` +
        `TUF Rating: ${passInfo.tufRating}\n` +
        `Feeling Rating: ${passInfo.feelingRating}\n\n` +
        'Accuracy\n' +
        `${passInfo.accuracy}\n\n` +
        'Score\n' +
        `${passInfo.score}`,
    )
    .setFooter('Footer', process.env.OWN_URL + '/v2/media/image/fa.png')
    .setTimestamp();

  return embed;
}

const passInfo: PassInfo = {
  player: '@Xios',
  tufRating: 'U8 | 21.1+',
  feelingRating: 'U7~U8',
  accuracy: '0.987173971497714',
  score: '3589.92',
  song: 'WYSI (When You See It)',
  artist: 'Camellia',
  link: 'https://www.youtube.com/watch?v=WUJn-txhs3k&lc=UgwOqTx8aipsiwQwjcB4AaABAg',
};

const passInfo2: PassInfo = {
  player: 'fos',
  tufRating: 'U28 | 21.15+',
  feelingRating: 'U7~U8',
  accuracy: '0.987173971497714',
  score: '3589.92',
  song: 'WYSI (When You See It)',
  artist: 'Camellia',
  link: 'https://www.youtube.com/watch?v=WUJn-txhs3k&lc=UgwOqTx8aipsiwQwjcB4AaABAg',
};

router.get('/testhook', async (req: Request, res: Response) => {
  try {
    const {CLEAR_ANNOUNCEMENT_HOOK} = process.env;
    const hook = new Webhook(CLEAR_ANNOUNCEMENT_HOOK || '');

    hook.setUsername('Sample name');
    hook.setAvatar(process.env.OWN_URL + '/v2/media/image/fa.png');

    const embed = createClearEmbed(passInfo);
    const embed3 = createClearEmbed(passInfo2);
    const embed2 = new MessageBuilder()
      .setAuthor(
        'sigma Webhook Node Author',
        '',
        'https://npmjs.org/package/discord-webhook-node',
      )
      .setColor('#000000')
      .setThumbnail(process.env.OWN_URL + '/v2/media/image/fa.png')
      .addField('Field #1', 'Not inline', false)
      .setDescription('Description')
      .setFooter('Footer', process.env.OWN_URL + '/v2/media/image/fa.png')
      .setTimestamp();

    const combined = MessageBuilder.combine(embed, embed2, embed3);

    hook
      .send(combined)
      .then(() => {
        console.log('sent');
      })
      .catch(err => console.error(err));

    return res.send('simga');
  } catch (error) {
    console.error('Error fetching image:', error);
    res.status(500).send('Error fetching image.');
    return;
  }
});

router.get('/announcementTest', async (req: Request, res: Response) => {
  try {
    const {CLEAR_ANNOUNCEMENT_HOOK} = process.env;
    const hook = new Webhook(CLEAR_ANNOUNCEMENT_HOOK || '');

    hook.setUsername('Sample name');
    hook.setAvatar(process.env.OWN_URL + '/v2/media/image/fa.png');

    const embed = createClearEmbed(passInfo);
    const embed3 = createClearEmbed(passInfo2);
    const embed2 = new MessageBuilder()
      .setAuthor(
        'sigma Webhook Node Author',
        '',
        'https://npmjs.org/package/discord-webhook-node',
      )
      .setColor('#000000')
      .setThumbnail(process.env.OWN_URL + '/v2/media/image/fa.png')
      .addField('Field #1', 'Not inline', false)
      .setDescription('Description')
      .setFooter('Footer', process.env.OWN_URL + '/v2/media/image/fa.png')
      .setTimestamp();

    const combined = MessageBuilder.combine(embed, embed2, embed3);

    hook
      .send(combined)
      .then(() => {
        console.log('sent');
      })
      .catch(err => console.error(err));

    return res.send('simga');
  } catch (error) {
    console.error('Error fetching image:', error);
    res.status(500).send('Error fetching image.');
    return;
  }
});

export default router;
