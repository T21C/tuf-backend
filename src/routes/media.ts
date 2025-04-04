import express, {Request, Response, Router} from 'express';
import fetch from 'node-fetch';
import axios from 'axios';
import path from 'path';
import fs from 'fs';
import sharp from 'sharp';
import Level from '../models/Level.js';
import Difficulty from '../models/Difficulty.js';
import {getVideoDetails} from '../utils/videoDetailParser.js';
import {initializeFonts} from '../utils/fontLoader.js';
import Pass from '../models/Pass.js';
import User from '../models/User.js';
import {Buffer} from 'buffer';
import { Op } from 'sequelize';
import { seededShuffle } from '../utils/random.js';

// Initialize fonts
initializeFonts();

const router: Router = express.Router();

function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function wrapText(
  text: string,
  maxChars: number,
): {lines: string[]; isWrapped: boolean} {
  const chars = text.split('');
  const lines = [];
  let currentLine = chars[0] || '';

  for (let i = 1; i < chars.length; i++) {
    const char = chars[i];
    if (currentLine.length < maxChars) {
      currentLine += char;
    } else {
      // If this is the last line and there are more characters
      if (lines.length === 1 && i < chars.length - 1) {
        currentLine = currentLine.slice(0, -3) + '...';
        lines.push(currentLine);
        break;
      }
      lines.push(currentLine);
      currentLine = char;
    }
  }
  if (currentLine && lines.length < 2) {
    lines.push(currentLine);
  }
  return {
    lines: lines.slice(0, 2),
    isWrapped: lines.length > 1,
  };
}

function createHeaderSVG(config: {
  width: number;
  height: number;
  headerHeight: number;
  song: string;
  artist: string;
  levelId: number;
  iconSize: number;
  iconPadding: number;
  titleFontSize: number;
  artistFontSize: number;
  idFontSize: number;
}): {svg: string; isWrapped: boolean} {
  const {lines, isWrapped} = wrapText(escapeXml(config.song), 27);

  // Adjust sizes if text is wrapped
  const titleFontSize = isWrapped
    ? Math.floor(config.titleFontSize * 0.85)
    : config.titleFontSize;
  const headerHeight = isWrapped
    ? Math.floor(config.headerHeight * 1.15)
    : config.headerHeight;
  const titleY = Math.floor(config.height * (isWrapped ? 0.1 : 0.12));
  const artistY = isWrapped
    ? Math.floor(config.height * 0.265)
    : Math.floor(config.height * 0.201);
  const textX = config.iconSize + config.iconPadding * 2;

  const escapedArtist = escapeXml(config.artist);

  return {
    svg: `
      <svg width="${config.width}" height="${config.height}">
        <defs>
          <style>
            @font-face {
              font-family: 'Noto Sans KR';
              font-weight: 800;
              src: url('path/to/NotoSansKR-Bold.otf');
            }
            @font-face {
              font-family: 'Noto Sans KR';
              font-weight: 400;
              src: url('path/to/NotoSansKR-Regular.otf');
            }
          </style>
        </defs>
        <rect x="0" y="0" width="${config.width}" height="${headerHeight}" fill="black" opacity="0.73"/>
        ${lines
          .map(
            (line, index) => `
          <text
            x="${textX}"
            y="${titleY + index * titleFontSize * 1.2}"
            font-family="Noto Sans KR"
            font-weight="800"
            font-size="${titleFontSize}px"
            fill="white"
          >${line}</text>
        `,
          )
          .join('')}
        <text
          x="${textX}"
          y="${artistY}"
          font-family="Noto Sans KR"
          font-weight="400"
          font-size="${config.artistFontSize}px"
          fill="white"
        >${escapedArtist.length > 30 ? escapedArtist.slice(0, 27) + '...' : escapedArtist}</text>
        <text
          x="${config.width - config.iconPadding * 1.5}"
          y="${titleY}"
          font-family="Noto Sans KR"
          font-weight="700"
          font-size="${config.idFontSize}px"
          fill="#bbbbbb"
          text-anchor="end"
        >#${config.levelId}</text>
      </svg>
    `,
    isWrapped,
  };
}

function createFooterSVG(config: {
  width: number;
  height: number;
  footerHeight: number;
  baseScore: number | null;
  passCount: number;
  creator: string | null;
  charter: string | null;
  vfxer: string | null;
  team: string | null;
  fontSize: number;
  idFontSize: number;
  padding: number;
}): string {
  const footerY = config.height - config.footerHeight;
  let creatorText = '';

  const truncate = (text: string, maxLength: number) =>
    text.length > maxLength ? text.slice(0, maxLength - 3) + '...' : text;

  if (config.team) {
    creatorText = `By ${truncate(escapeXml(config.team), 25)}`;
  } else if (config.charter && config.vfxer) {
    creatorText = `Chart: ${truncate(escapeXml(config.charter), 20)}&#10;VFX: ${truncate(escapeXml(config.vfxer), 20)}`;
  } else if (config.charter) {
    creatorText = `By ${truncate(escapeXml(config.charter), 25)}`;
  } else if (config.creator) {
    creatorText = `By ${truncate(escapeXml(config.creator), 25)}`;
  }

  return `
    <svg width="${config.width}" height="${config.height}">
      <rect x="0" y="${footerY}" width="${config.width}" height="${config.footerHeight}" fill="black" opacity="0.73"/>
      <text
        x="${config.padding}"
        y="${config.height - config.padding * 2.5}"
        font-family="Noto Sans JP"
        font-weight="700"
        font-size="${config.idFontSize}px"
        fill="#bbbbbb"
      >${config.baseScore || 0}PP</text>
      <text
        x="${config.padding}"
        y="${config.height - config.padding}"
        font-family="Noto Sans JP"
        font-weight="700"
        font-size="${config.idFontSize}px"
        fill="#bbbbbb"
      >${config.passCount} pass${config.passCount.toString().endsWith('1') ? '' : 'es'}</text>
      <text
        x="${config.width - config.padding}"
        y="${config.height - config.padding}"
        font-family="Noto Sans JP"
        font-weight="600"
        font-size="${config.fontSize}px"
        fill="white"
        text-anchor="end"
      >${creatorText}</text>
    </svg>
  `;
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

router.get('/avatar/:userId', async (req: Request, res: Response) => {
  const {userId} = req.params;
  try {
    const user = await User.findByPk(userId);
    if (!user || !user.avatarUrl) {
      return res.status(404).send('Avatar not found');
    }

    // Create cache directory if it doesn't exist
    const cacheDir = path.join(process.cwd(), 'cache', 'avatars');
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, {recursive: true});
    }

    const avatarPath = path.join(cacheDir, `${userId}.png`);

    // If avatar is not cached, download it
    if (!fs.existsSync(avatarPath)) {
      const response = await axios.get(user.avatarUrl, {
        responseType: 'arraybuffer',
      });

      // Process and save the image
      await sharp(response.data)
        .resize(256, 256, {
          fit: 'cover',
          position: 'center',
        })
        .png()
        .toFile(avatarPath);
    }

    return res.sendFile(avatarPath);
  } catch (error) {
    console.error('Error serving avatar:', error);
    return res.status(500).send('Error serving avatar');
  }
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
  const {type, path: imagePath} = req.params;
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

// Define size presets
const THUMBNAIL_SIZES = {
  SMALL: {width: 400, height: 210}, // 16:9 ratio
  MEDIUM: {width: 800, height: 420},
  LARGE: {width: 1200, height: 630},
} as const;

router.get('/thumbnail/level/:levelId', async (req: Request, res: Response) => {
  try {
    const size = (req.query.size as keyof typeof THUMBNAIL_SIZES) || 'MEDIUM';
    const levelId = parseInt(req.params.levelId);

    const level = await Level.findOne({
      where: {id: levelId},
      include: [
        {model: Difficulty, as: 'difficulty'},
        {model: Pass, as: 'passes', attributes: ['id']},
      ],
    });

    if (!level) {
      return res.status(404).send('Level or difficulty not found');
    }

    const {song, artist, creator, difficulty: diff} = level.dataValues;
    if (!diff) {
      return res.status(404).send('Difficulty not found');
    }

    const details = await getVideoDetails(level.dataValues.videoLink);
    if (!details || !details.image) {
      return res.status(404).send('Video details not found');
    }

    const {width, height} = THUMBNAIL_SIZES[size];

    // Calculate dimensions
    const iconSize = Math.floor(height * 0.184);
    const titleFontSize = Math.floor(height * 0.09);
    const artistFontSize = Math.floor(height * 0.06);
    const idFontSize = Math.floor(height * 0.072);
    const iconPadding = Math.floor(height * 0.037);
    const headerHeight = Math.floor(height * 0.255);
    const footerHeight = Math.floor(height * 0.255);
    const fontSize = Math.floor(height * 0.06);
    const padding = Math.floor(height * 0.055);

    // Download background image
    const backgroundBuffer = await axios
      .get(details.image, {responseType: 'arraybuffer'})
      .then(response => response.data);

    // Download difficulty icon
    const iconBuffer = await axios
      .get(diff.icon, {responseType: 'arraybuffer'})
      .then(response => response.data);

    // Create SVGs for text overlays
    const {svg: headerSvg, isWrapped} = createHeaderSVG({
      width,
      height,
      headerHeight,
      song,
      artist,
      levelId,
      iconSize,
      iconPadding,
      titleFontSize,
      artistFontSize,
      idFontSize,
    });

    const footerSvg = createFooterSVG({
      width,
      height,
      footerHeight,
      baseScore: diff.baseScore,
      passCount: level.passes?.length || 0,
      creator,
      charter: level.charter,
      vfxer: level.vfxer,
      team: level.team,
      fontSize,
      idFontSize,
      padding,
    });

    // Create the final image using sharp
    const image = await sharp(backgroundBuffer)
      .resize(width, height, {
        fit: 'cover',
        position: 'center',
      })
      .composite([
        {
          input: Buffer.from(headerSvg),
          top: 0,
          left: 0,
        },
        {
          input: await sharp(iconBuffer).resize(iconSize, iconSize).toBuffer(),
          top: isWrapped ? Math.floor(iconPadding * 1.5) : iconPadding,
          left: iconPadding,
        },
        {
          input: Buffer.from(footerSvg),
          top: 0,
          left: 0,
        },
      ])
      .jpeg({quality: 85});

    const buffer = await image.toBuffer();

    res.set('Content-Type', 'image/jpeg');
    res.send(buffer);
    return;
  } catch (error) {
    console.error('Error generating image for level id:', req.params.levelId, error);
    res.status(500).send('Error generating image');
    return;
  }
});

// Add wheel image generation endpoint
router.get('/wheel-image/:seed', async (req: Request, res: Response) => {
  try {
    const seed = parseInt(req.params.seed);
    if (isNaN(seed)) {
      return res.status(400).send('Invalid seed');
    }

    // Get levels with the same seed logic
    const levels = await Level.findAll({
      where: {
        isDeleted: false,
        isHidden: false,
        diffId: {
          [Op.ne]: 0
        }
      },
      include: [
        {
          model: Difficulty,
          as: 'difficulty',
          required: false,
          attributes: ['color']
        }
      ],
      attributes: ['id', 'song']
    });

    const modLevels = levels.filter(level => level.id % 4 === 0);
    // Shuffle array using seeded random
    const shuffledLevels = seededShuffle(modLevels, seed);

    // Create SVG for the wheel
    const width = 800;
    const height = 800;
    const centerX = width / 2;
    const centerY = height / 2;
    const radius = Math.min(width, height) / 2 - 20;
    const itemCount = shuffledLevels.length;
    const anglePerItem = 360 / itemCount;

    // Generate SVG segments
    const segments = shuffledLevels.map((level, index) => {
      const startAngle = index * anglePerItem;
      const endAngle = (index + 1) * anglePerItem;
      const startRad = (startAngle - 90) * Math.PI / 180;
      const endRad = (endAngle - 90) * Math.PI / 180;
      
      const x1 = centerX + radius * Math.cos(startRad);
      const y1 = centerY + radius * Math.sin(startRad);
      const x2 = centerX + radius * Math.cos(endRad);
      const y2 = centerY + radius * Math.sin(endRad);
      const largeArcFlag = anglePerItem > 180 ? 1 : 0;

      return `
        <path
          d="M ${centerX} ${centerY} L ${x1} ${y1} A ${radius} ${radius} 0 ${largeArcFlag} 1 ${x2} ${y2} Z"
          fill="${level.difficulty?.color || '#666666'}"
        />
      `;
    }).join('');

    // Create the complete SVG
    const svg = `
      <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <filter id="glow">
            <feGaussianBlur stdDeviation="2" result="coloredBlur"/>
            <feMerge>
              <feMergeNode in="coloredBlur"/>
              <feMergeNode in="SourceGraphic"/>
            </feMerge>
          </filter>
        </defs>
        <g filter="url(#glow)">
          ${segments}
        </g>
      </svg>
    `;

    // Convert SVG to PNG using sharp
    const buffer = await sharp(Buffer.from(svg))
      .png()
      .toBuffer();

    res.set('Content-Type', 'image/png');
    return res.send(buffer);
  } catch (error) {
    console.error('Error generating wheel image:', error);
    return res.status(500).send('Error generating wheel image');
  }
});

export default router;