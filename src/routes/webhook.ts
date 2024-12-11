import express, {Request, Response, Router} from 'express';
import fetch from 'node-fetch';
import {loadPfpList} from '../utils/fileHandlers.js';
import axios from 'axios';
import path from 'path';
import fs from 'fs';
import {Webhook, MessageBuilder} from '../webhook/index';

const router: Router = express.Router();

router.get('/testhook', async (req: Request, res: Response) => {
  try {
    const {CLEAR_ANNOUNCEMENT_HOOK, OWN_URL} = process.env;
    const hook = new Webhook(CLEAR_ANNOUNCEMENT_HOOK || '');

    hook.setUsername('Sample name');
    hook.setAvatar(OWN_URL + '/v2/media/image/fa.png');

    const embed = new MessageBuilder();
    embed
      .setText('<@&1316144118274981949>')
      .setAuthor(
        'sigma Webhook Node Author',
        OWN_URL + '/v2/media/image/fa.png',
        'https://npmjs.org/package/discord-webhook-node',
      )
      .setColor('#000000')
      .setThumbnail(OWN_URL + '/v2/media/image/fa.png')
      .addField('Field #1', 'Not inline', false)
      .setDescription('Description')
      .setFooter('Footer', OWN_URL + '/v2/media/image/fa.png')
      .setTimestamp();

    const embed2 = new MessageBuilder();
    embed2
      .setAuthor(
        'sigma Webhook Node Author',
        OWN_URL + '/v2/media/image/fa.png',
        'https://npmjs.org/package/discord-webhook-node',
      )
      .setColor('#000000')
      .setThumbnail(OWN_URL + '/v2/media/image/fa.png')
      .addField('Field #1', 'Not inline', false)
      .setDescription('Description')
      .setFooter('Footer', OWN_URL + '/v2/media/image/fa.png')
      .setTimestamp();

    const combined = MessageBuilder.combine(embed, embed2);

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
