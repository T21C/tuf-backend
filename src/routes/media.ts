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
import { IDifficulty, ILevel } from '../interfaces/models/index.js';

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
router.get('/image/:type/:path', async (req: Request, res: Response) => {
  const { type, path: imagePath } = req.params;
  try {
    if (!imagePath || typeof imagePath !== 'string') {
      return res.status(400).send('Invalid image path');
    }

    // Sanitize the path to prevent directory traversal
    const sanitizedPath = path
      .normalize(imagePath)
      .replace(/^(\.\.(\/|\\|$))+/, '');

    let basePath;
    if (type === 'icon') {
      basePath = path.join(process.cwd(), 'cache', 'icons');
    } else {
      basePath = path.join(process.cwd(), 'cache');
    }

    const fullPath = path.join(basePath, sanitizedPath);

    // Verify the path is within the allowed directory
    if (!fullPath.startsWith(basePath)) {
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
    level?: ILevel;
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
  const height = ctx.canvas.height;

  // Calculate relative sizes (increased by 15%)
  const iconSize = Math.floor(height * 0.184);      // was 0.16
  const titleFontSize = Math.floor(height * 0.09); // was 0.087
  const artistFontSize = Math.floor(height * 0.06); // was 0.048
  const idFontSize = Math.floor(height * 0.072);    // was 0.063
  const maxWidth = width - Math.floor(width * 0.288); // was 0.25
  const lineHeight = Math.floor(height * 0.095); // was 0.095

  // Title text wrapping
  ctx.font = `800 ${titleFontSize}px "Noto Sans KR"`;
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  const lines = wrapText(ctx, song, maxWidth, lineHeight);
  
  // Adjust background height based on lines
  ctx.fillStyle = '#000000bb';
  const headerHeight = lines.length > 1 ? Math.floor(height * 0.329) : Math.floor(height * 0.255); // was 0.286 and 0.222

  ctx.fillRect(0, 0, width, headerHeight);

  // Draw difficulty icon
  const iconPadding = Math.floor(height * 0.037); // was 0.032
  ctx.drawImage(await loadImage(difficultyIcon), iconPadding, iconPadding, iconSize, iconSize);

  // Draw song title lines
  const titleY = Math.floor(height * 0.12); // was 0.111
  lines.forEach((line, index) => {
    const y = titleY + (index * lineHeight);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(line, iconSize + iconPadding * 2, y);
  });

  // Draw artist name
  const artistY = lines.length > 1 ? Math.floor(height * 0.29) : Math.floor(height * 0.201); // was 0.238 and 0.175
  ctx.font = `400 ${artistFontSize}px "Noto Sans KR"`;
  ctx.fillText(artist, iconSize + iconPadding * 2, artistY);

  // Draw level ID
  ctx.font = `700 ${idFontSize}px "Noto Sans KR"`;
  ctx.fillStyle = '#bbbbbb';
  ctx.textAlign = 'right';
  ctx.fillText("#"+levelId.toString(), width - iconPadding * 1.5, titleY);

  return headerHeight;
}

async function drawFooter(ctx: CanvasRenderingContext2D, config: FooterConfig) {
  const width = ctx.canvas.width;
  const height = ctx.canvas.height;
  
  const level = config.data.level;
  const team = level?.team ? level?.team : null;
  const charter = level?.charter ? level?.charter : null;
  const creator = level?.creator ? level?.creator : null;
  const vfxer = level?.vfxer ? level?.vfxer : null;

  console.log(team, charter, creator, vfxer);
  // Calculate relative sizes (increased by 15%)
  const footerHeight = Math.floor(height * 0.255); // was 0.222
  const fontSize = Math.floor(height * 0.06);     // was 0.048
  const padding = Math.floor(height * 0.055);      // was 0.048
  
  const idFontSize = Math.floor(height * 0.072);    // was 0.063
  ctx.fillStyle = '#000000bb';
  
  switch(config.preset) {
    case 'level':
      // Draw footer background
      ctx.fillRect(0, height - footerHeight, width, footerHeight);
      
      // Draw baseScore with same styling as ID
      ctx.font = `700 ${idFontSize}px "Noto Sans JP"`;
      ctx.fillStyle = '#bbbbbb';
      ctx.textAlign = 'left';
      ctx.fillText(
        (config.data.baseScore || config.data.difficulty?.baseScore || '0') + 'PP',
        padding,
        height - padding*2.5
      );     
      ctx.fillText(
        `${config.data.passCount || 0} pass${config.data.passCount?.toString().endsWith('1') ? '' : 'es'}`, 
        padding,
        height - padding
      );
      
      // Draw creator and pass count
      ctx.font = `600 ${fontSize}px "Noto Sans JP"`;
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'right';

      if (team)
      ctx.fillText(
        `By ${team}`, 
        width - padding, 
        height - padding
      );
      else if (charter && vfxer) {
        ctx.fillText(
          `Chart: ${charter}\nVFX: ${vfxer}`, 
          width - padding, 
          height - padding * 2
        );
      }
      else if (charter) {
        ctx.fillText(
          `By ${charter}`, 
          width - padding, 
          height - padding
        );
      }
      else {
        ctx.fillText(
          `By ${creator}`, 
          width - padding, 
          height - padding
        );
      }

      
      break;
      
    case 'profile':
      break;
      
    case 'leaderboard':
      break;
  }
}

// Define size presets
const THUMBNAIL_SIZES = {
  SMALL: { width: 400, height: 210 },    // 16:9 ratio
  MEDIUM: { width: 800, height: 420 },
  LARGE: { width: 1200, height: 630 }
} as const;

router.get('/thumbnail/level/:levelId', async (req: Request, res: Response) => {
  try {
    const size = (req.query.size as keyof typeof THUMBNAIL_SIZES) || 'MEDIUM';
    const levelId = parseInt(req.params.levelId);

    // If not cached, generate the thumbnail
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

    const details = await getVideoDetails(level.dataValues.videoLink);
    if (!details || !details.image) {
      return res.status(404).send('Video details not found');
    }

    const { image } = details;
    const { width, height } = THUMBNAIL_SIZES[size];
    
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // Draw background image
    const img = await loadImage(image);
    const imgAspectRatio = img.width / img.height;
    const canvasAspectRatio = width / height;
    
    let drawWidth = width;
    let drawHeight = height;
    let offsetX = 0;
    let offsetY = 0;
    
    if (imgAspectRatio > canvasAspectRatio) {
      // Image is wider than canvas
      drawWidth = height * imgAspectRatio;
      offsetX = -(drawWidth - width) / 2;
    } else {
      // Image is taller than canvas
      drawHeight = width / imgAspectRatio;
      offsetY = -(drawHeight - height) / 2;
    }
    
    ctx.drawImage(img, offsetX, offsetY, drawWidth, drawHeight);

    // Draw header
    await drawHeader(ctx, {
      song,
      artist,
      levelId,
      difficultyIcon: diff.icon,
      maxWidth: width - Math.floor(width / 5), // 20% margin
      lineHeight: Math.floor(height / 9) // Scale lineHeight based on height
    });

    // Draw footer
    await drawFooter(ctx, {
      preset: 'level',
      data: {
        level,
        difficulty: diff,
        creator,
        passCount: level.passes?.length || 0
      }
    });

    // Save to cache
    const buffer = await sharp(canvas.toBuffer())
      .jpeg({ quality: 85 })
      .toBuffer();

    res.set({
      'Content-Type': 'image/jpeg',
      //'Cache-Control': 'public, max-age=3600' // Cache for 24 hours
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
