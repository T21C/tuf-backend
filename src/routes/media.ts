import express, {Request, Response, Router} from 'express';
import fetch from 'node-fetch';
import {loadPfpList} from '../utils/fileHandlers.js';
import axios from 'axios';
import path from 'path';
import fs from 'fs';
import sharp from 'sharp';
import { createCanvas, loadImage, registerFont } from 'canvas';
import Level from '../models/Level.js';
import Difficulty from '../models/Difficulty.js';
import { getVideoDetails } from '../utils/videoDetailParser.js';

const router: Router = express.Router();

router.get('/image-proxy', async (req: Request, res: Response) => {
  const imageUrl = req.query.url;
  try {
    if (!imageUrl || typeof imageUrl !== 'string') {
      return res.status(400).send('Invalid image URL');
    }

    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
    });

    const contentType = response.headers['content-type'];
    res.set('Content-Type', contentType);

    return res.send(response.data);
  } catch (error) {
    console.error('Error fetching image:', error);
    res.status(500).send('Error fetching image.');
    return;
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

router.get('/github-asset', async (req: Request, res: Response) => {
  const assetPath = req.query.path;
  try {
    if (!assetPath || typeof assetPath !== 'string') {
      return res.status(400).send('Invalid asset path');
    }

    const githubUrl = `https://raw.githubusercontent.com/T21C/T21C-assets/main/${assetPath}`;
    const response = await axios.get(githubUrl, {
      responseType: 'arraybuffer',
    });

    const contentType = response.headers['content-type'];
    res.set('Content-Type', contentType);
    return res.send(response.data);
  } catch (error) {
    console.error('Error fetching GitHub asset:', error);
    res.status(500).send('Error fetching asset.');
    return;
  }
});

router.get('/image/:path', async (req: Request, res: Response) => {
  const imagePath = req.params.path;
  try {
    if (!imagePath || typeof imagePath !== 'string') {
      return res.status(400).send('Invalid image path');
    }

    // Sanitize the path to prevent directory traversal
    const sanitizedPath = path
      .normalize(imagePath)
      .replace(/^(\.\.(\/|\\|$))+/, '');
    const fullPath = path.join(process.cwd(), 'cache', sanitizedPath);

    // Verify the path is within the cache directory
    if (!fullPath.startsWith(path.join(process.cwd(), 'cache'))) {
      return res.status(403).send('Access denied');
    }

    // Check if file exists
    if (!fs.existsSync(fullPath)) {
      return res.status(404).send('Image not found');
    }

    // Get file extension and set content type
    const ext = path.extname(fullPath).toLowerCase();
    const contentType =
      {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
      }[ext] || 'application/octet-stream';

    res.set('Content-Type', contentType);
    return res.sendFile(fullPath);
  } catch (error) {
    console.error('Error serving cached image:', error);
    return res.status(500).send('Error serving image');
  }
});

router.get('/thumbnail/level/:levelId', async (req: Request, res: Response) => {
  try {
    const levelId = parseInt(req.params.levelId);
    const level = await Level.findOne({ where: { id: levelId }, include: [{ model: Difficulty, as: 'difficulty' }] });
    if (!level) {
      return res.status(404).send('Level or difficulty not found');
    }
    const { song, artist, creator, difficulty: diff } = level.dataValues;
    if (!diff) {
      return res.status(404).send('Difficulty not found');
    }
    const details = await getVideoDetails(level.dataValues.vidLink);
    if (!details || !details.image) {
      return res.status(404).send('Video details not found');
    }
    const { image } = details;
    // Create a canvas with specified dimensions
    
    const width = 1200;
    const height = 630;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // Set background
    ctx.fillStyle = '#1a1a1a';
    ctx.drawImage(await loadImage(image), 0, 0, width, height);
    ctx.drawImage(await loadImage(diff.icon), 20, 20, 100, 100);
    // Add text example (you can customize this based on query parameters)
    ctx.font = 'bold 60px Arial';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.fillText(req.query.text?.toString() || 'Dynamic Image', width / 2, height / 2);

    // Convert canvas to buffer using Sharp for optimization
    const buffer = await sharp(canvas.toBuffer())
      .jpeg({ quality: 90 })
      .toBuffer();

    // Set cache headers (cache for 1 hour)
    res.set({
      'Content-Type': 'image/jpeg',
      //'Cache-Control': 'public, max-age=3600',
    });

    // Send the optimized image
    res.send(buffer);
    return;
  } catch (error) {
    console.error('Error generating image:', error);
    res.status(500).send('Error generating image');
    return;
  }
});

export default router;
