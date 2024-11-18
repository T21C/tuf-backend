import express, {Request, Response, Router} from 'express';
import fetch from 'node-fetch';
import {loadPfpList} from '../utils/fileHandlers.js';
import {PATHS} from '../config/constants.js';
import {decodeFromBase32} from '../utils/encodingHelpers.js';
import axios from 'axios';

const router: Router = express.Router();

router.get('/image', async (req: Request, res: Response) => {
  const imageUrl = req.query.url;
  try {
    if (!imageUrl || typeof imageUrl !== 'string') {
      return res.status(400).send('Invalid image URL');
    }

    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer'
    });

    const contentType = response.headers['content-type'];
    res.set('Content-Type', contentType);

    return res.send(response.data);

  } catch (error) {
    console.error('Error fetching image:', error);
    res.status(500).send('Error fetching image.');
    return
  }
});

router.get('/bilibili', async (req: Request, res: Response) => {
  const bvid = req.query.bvid;
  const apiUrl = `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`;

  try {
    const response = await fetch(apiUrl);
    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    return res.json(data);
  } catch (error) {
    console.error('Error fetching data:', error);
    return res.status(500).json({error: 'Internal Server Error'});
  }
});

router.get('/pfp', async (req: Request, res: Response) => {
  const player = req.query.player as string;
  const pfpList = loadPfpList();
  res.json(pfpList[player]);
});

export default router;
