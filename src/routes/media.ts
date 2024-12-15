import express, {Request, Response, Router} from 'express';
import fetch from 'node-fetch';
import {loadPfpList} from '../utils/fileHandlers.js';
import axios from 'axios';
import path from 'path';
import fs from 'fs';
import sharp from 'sharp';
import { CanvasRenderingContext2D, createCanvas, loadImage } from 'canvas';
import Level from '../models/Level.js';
import Difficulty from '../models/Difficulty.js';
import { getVideoDetails } from '../utils/videoDetailParser.js';
import { initializeFonts } from '../utils/fontLoader.js';
import Pass from '../models/Pass.js';
import { IDifficulty } from '../interfaces/models/index.js';

// Initialize fonts
initializeFonts();

const router: Router = express.Router();

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, lineHeight: number) {
  const words = text.split('');
  const lines = [];
  let currentLine = words[0] || '';

  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    const width = ctx.measureText(currentLine + word).width;
    if (width < maxWidth) {
      currentLine += word;
    } else {
      lines.push(currentLine);
      currentLine = word;
    }
  }
  console.log(lines);
  lines.push(currentLine);
  return lines.slice(0, 2); // Return maximum 2 lines
}

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

interface HeaderConfig {
  song: string;
  artist: string;
  levelId: number;
  difficultyIcon: string;
  maxWidth?: number;
  lineHeight?: number;
}

interface FooterConfig {
  preset: 'level' | 'profile' | 'leaderboard';
  data: {
    baseScore?: number | null;
    difficulty?: IDifficulty;
    rating?: number;
    creator?: string;
    passCount?: number;
    [key: string]: any;
  };
}

async function drawHeader(ctx: CanvasRenderingContext2D, config: HeaderConfig) {
  const { song, artist, levelId, difficultyIcon } = config;
  const width = ctx.canvas.width;
  const maxWidth = config.maxWidth || width - 300;
  const lineHeight = config.lineHeight || 60;

  // Title text wrapping
  ctx.font = '800 55px "Noto Sans KR"';
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  const lines = wrapText(ctx, song, maxWidth, lineHeight);
  
  // Adjust background height based on lines
  ctx.fillStyle = '#000000bb';
  const headerHeight = lines.length > 1 ? 180 : 140;
  ctx.fillRect(0, 0, width, headerHeight);

  // Draw difficulty icon
  ctx.drawImage(await loadImage(difficultyIcon), 20, 20, 100, 100);

  // Draw song title lines
  lines.forEach((line, index) => {
    const y = 70 + (index * lineHeight);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(line, 140, y);
  });

  // Draw artist name
  const artistY = lines.length > 1 ? 150 : 110;
  ctx.font = '400 30px "Noto Sans KR"';
  ctx.fillText(artist, 140, artistY);

  // Draw level ID
  ctx.font = '700 40px "Noto Sans KR"';
  ctx.fillStyle = '#bbbbbb';
  ctx.textAlign = 'right';
  ctx.fillText("#"+levelId.toString(), width-30, 60);

  return headerHeight;
}

async function drawFooter(ctx: CanvasRenderingContext2D, config: FooterConfig) {
  const width = ctx.canvas.width;
  const height = ctx.canvas.height;
  
  ctx.fillStyle = '#000000bb';
  
  switch(config.preset) {
    case 'level':
      // Draw footer background
      ctx.fillRect(0, height - 140, width, 140);
      
      // Draw difficulty and rating
      ctx.font = '600 30px "Noto Sans KR"';
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'left';
      ctx.fillText(`${config.data.difficulty?.name || 'Unknown'} · ${config.data.baseScore || config.data.difficulty?.baseScore || '0'}PP`, 30, height - 30);
      
      // Draw creator and pass count
      ctx.textAlign = 'right';
      ctx.fillText(
        `${config.data.creator || 'Unknown'} · ${config.data.passCount || 0} passes`, 
        width - 30, 
        height - 100
      );
      break;
      
    case 'profile':
      // Add profile footer preset here
      break;
      
    case 'leaderboard':
      // Add leaderboard footer preset here
      break;
  }
}

router.get('/thumbnail/level/:levelId', async (req: Request, res: Response) => {
  try {
    const levelId = parseInt(req.params.levelId);
    const level = await Level.findOne({ 
      where: { id: levelId }, 
      include: [
        { model: Difficulty, as: 'difficulty' },
        { model: Pass, as: 'passes', attributes: ['id'] }
      ] 
    });
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
    
    const width = 1200;
    const height = 630;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // Draw background image
    ctx.drawImage(await loadImage(image), 0, 0, width, height);

    // Draw header
    await drawHeader(ctx, {
      song,
      artist,
      levelId,
      difficultyIcon: diff.icon,
      maxWidth: width - 300,
      lineHeight: 60
    });

    // Draw footer
    await drawFooter(ctx, {
      preset: 'level',
      data: {
        difficulty: diff,
        creator,
        passCount: level.passes?.length || 0
      }
    });

    // Convert canvas to buffer using Sharp for optimization
    const buffer = await sharp(canvas.toBuffer())
      .toBuffer();

    res.set({
      'Content-Type': 'image/jpeg'
    });

    res.send(buffer);
    return;
  } catch (error) {
    console.error('Error generating image:', error);
    res.status(500).send('Error generating image');
    return;
  }
});

export default router;
