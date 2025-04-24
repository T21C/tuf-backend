import express, {Request, Response, Router} from 'express';
import fetch from 'node-fetch';
import axios from 'axios';
import path from 'path';
import fs from 'fs';
import puppeteer from 'puppeteer';
import Level from '../../models/levels/Level.js';
import Difficulty from '../../models/levels/Difficulty.js';
import {getVideoDetails} from '../../utils/videoDetailParser.js';
import Pass from '../../models/passes/Pass.js';
import User from '../../models/auth/User.js';
import {Buffer} from 'buffer';
import { Op } from 'sequelize';
import { seededShuffle } from '../../utils/random.js';
import { logger } from '../../utils/logger.js';
import { checkMemoryUsage } from '../../utils/memUtils.js';
import Creator from '../../models/credits/Creator.js';
import { CreatorAlias } from '../../models/credits/CreatorAlias.js';
import Team from '../../models/credits/Team.js';
import { TeamAlias } from '../../models/credits/TeamAlias.js';
import LevelCredit from '../../models/levels/LevelCredit.js';
import sharp from 'sharp';

// Define size presets
const THUMBNAIL_SIZES = {
  SMALL: {width: 400, height: 210, multiplier: 0.5}, // 16:9 ratio
  MEDIUM: {width: 800, height: 420, multiplier: 1},
  LARGE: {width: 1200, height: 630, multiplier: 1.5},
} as const;

// Cache directories
const CACHE_DIR = path.join(process.cwd(), 'cache');
const THUMBNAILS_CACHE_DIR = path.join(CACHE_DIR, 'thumbnails');

// Ensure cache directories exist
[THUMBNAILS_CACHE_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Cache TTL in milliseconds (20 seconds) for development, 12 hours for production
const CACHE_TTL = process.env.NODE_ENV === 'production' ? 12 * 60 * 60 * 1000 : 20 * 1000;

// Cleanup interval in milliseconds (5 minutes)
const CLEANUP_INTERVAL = 5 * 60 * 1000;

// Function to check if a cached file is expired
function isCacheExpired(filePath: string): boolean {
  try {
    const stats = fs.statSync(filePath);
    const age = Date.now() - stats.mtimeMs;
    return age > CACHE_TTL;
  } catch {
    return true;
  }
}

// Function to clean expired cache
function cleanExpiredCache(filePath: string): void {
  if (fs.existsSync(filePath) && isCacheExpired(filePath)) {
    fs.unlinkSync(filePath);
  }
}

// Function to clean all expired cache files in a directory
function cleanExpiredCacheDirectory(directory: string): void {
  try {
    if (!fs.existsSync(directory)) return;
    
    const files = fs.readdirSync(directory);
    let cleanedCount = 0;
    
    for (const file of files) {
      const filePath = path.join(directory, file);
      if (fs.existsSync(filePath) && isCacheExpired(filePath)) {
        fs.unlinkSync(filePath);
        cleanedCount++;
      }
    }
    
    if (cleanedCount > 0) {
      logger.debug(`Cleaned up ${cleanedCount} expired cache files from ${directory}`);
    }
  } catch (error) {
    logger.error(`Error cleaning cache directory ${directory}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Function to clean all expired cache files
function cleanAllExpiredCache(): void {
  cleanExpiredCacheDirectory(THUMBNAILS_CACHE_DIR);
}

// Start periodic cleanup
setInterval(cleanAllExpiredCache, CLEANUP_INTERVAL);

// Run initial cleanup
cleanAllExpiredCache();

// Function to get cached thumbnail path
function getThumbnailPath(levelId: number, size: keyof typeof THUMBNAIL_SIZES): string {
  return path.join(THUMBNAILS_CACHE_DIR, `${levelId}_${size}.png`);
}

// Singleton Puppeteer instance
let browser: puppeteer.Browser | null = null;

async function getBrowser(): Promise<puppeteer.Browser> {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: true,
      defaultViewport: null,
      args: [
        '--disable-setuid-sandbox',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu'
      ]
    });
  }
  return browser;
}

// Add this helper function for retrying image downloads
async function downloadImageWithRetry(url: string, maxRetries = 5, delayMs = 5000): Promise<Buffer> {
  let lastError: Error | unknown;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      logger.debug(`Attempting to download image from ${url} (attempt ${attempt}/${maxRetries})`);
      const response = await axios.get(url, { responseType: 'arraybuffer' });
      logger.debug(`Successfully downloaded image from ${url} on attempt ${attempt}`);
      return response.data;
    } catch (error: unknown) {
      lastError = error;
      logger.warn(`Failed to download image from ${url} on attempt ${attempt}/${maxRetries}: ${error instanceof Error ? error.message : String(error)}`);
      
      if (attempt < maxRetries) {
        logger.debug(`Waiting ${delayMs}ms before retrying...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }
  
  logger.error(`All ${maxRetries} attempts to download image from ${url} failed. Using black background instead.`);
  throw lastError;
}

// Function to convert HTML to PNG
async function htmlToPng(html: string, width: number, height: number): Promise<Buffer> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  
  try {
    await page.setViewport({ width, height });
    await page.setContent(html);
    
    const pngBuffer = await page.screenshot({
      type: 'png',
      omitBackground: true
    });
    
    return Buffer.from(pngBuffer);
  } finally {
    await page.close();
  }
}

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

      // Save the image directly
      fs.writeFileSync(avatarPath, response.data);
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

router.get('/thumbnail/level/:levelId', async (req: Request, res: Response) => {
  try {
    const size = (req.query.size as keyof typeof THUMBNAIL_SIZES) || 'MEDIUM';
    const levelId = parseInt(req.params.levelId);
    logger.debug(`Generating thumbnail for level ${levelId} with size ${size}`);

    // Get the cache path for LARGE version only
    const largeCachePath = getThumbnailPath(levelId, 'LARGE');

    // Clean expired cache file
    cleanExpiredCache(largeCachePath);

    // Check if we have a valid cached LARGE version
    let largeBuffer: Buffer;
    if (fs.existsSync(largeCachePath) && !isCacheExpired(largeCachePath)) {
      logger.debug(`Using cached LARGE thumbnail for level ${levelId}`);
      largeBuffer = await fs.promises.readFile(largeCachePath);
    } else {
      // Generate and cache LARGE version
      const level = await Level.findOne({
        where: {id: levelId},
        include: [
          {model: Difficulty, as: 'difficulty'},
          {model: LevelCredit, as: 'levelCredits', 
            attributes: ['role'],
            include: [
              {model: Creator, as: 'creator', 
                attributes: ['name'],
                include: [
                  {model: CreatorAlias, as: 'creatorAliases', attributes: ['name']}
                ],
              },
            ],
          },
          {model: Team, as: 'teamObject', 
            attributes: ['name'],
            include: [
              {model: TeamAlias, as: 'teamAliases', attributes: ['name']}
            ],
          },
          {model: Pass, as: 'passes', attributes: ['id']},
        ],
      });

      if (!level) {
        return res.status(404).send('Level or difficulty not found');
      }

      const {song, artist, difficulty: diff} = level.dataValues;
      if (!diff) {
        return res.status(404).send('Difficulty not found');
      }

      const details = await getVideoDetails(level.dataValues.videoLink);
      if (!details || !details.image) {
        return res.status(404).send('Video details not found');
      }

      // Generate the HTML and PNG for LARGE size
      const {width, height, multiplier} = THUMBNAIL_SIZES.LARGE;
      const iconSize = Math.floor(height * 0.184);

      // Download background image with retry logic
      let backgroundBuffer: Buffer;
      try {
        backgroundBuffer = await downloadImageWithRetry(details.image);
      } catch (error: unknown) {
        logger.error(`Failed to download background image after all retries: ${error instanceof Error ? error.message : String(error)}`);
        // Create a black background
        backgroundBuffer = Buffer.alloc(width * height * 4, 0);
      }

      // Download difficulty icon with retry logic
      let iconBuffer: Buffer;
      try {
        // Extract the icon path from the URL
        const iconUrl = new URL(diff.icon);
        const iconPath = iconUrl.pathname.split('/').pop();
        
        if (!iconPath) {
          throw new Error('Invalid icon URL');
        }
        
        // Sanitize the path to prevent directory traversal
        const sanitizedPath = path
          .normalize(iconPath)
          .replace(/^(\.\.(\/|\\|$))+/, '');
        
        // Construct the full path to the icon in the cache
        const basePath = path.join(process.cwd(), 'cache', 'icons');
        const fullPath = path.join(basePath, sanitizedPath);
        
        // Verify the path is within the allowed directory
        if (!fullPath.startsWith(basePath)) {
          throw new Error('Access denied');
        }
        
        // Check if file exists in cache
        if (fs.existsSync(fullPath)) {
          iconBuffer = await fs.promises.readFile(fullPath);
        } else {
          iconBuffer = await downloadImageWithRetry(diff.icon);
        }
      } catch (error: unknown) {
        logger.error(`Failed to get difficulty icon: ${error instanceof Error ? error.message : String(error)}`);
        // Create a placeholder icon
        iconBuffer = Buffer.alloc(iconSize * iconSize * 4, 100);
      }
      const artistOverflow = artist.length > 35;
      const songOverflow = song.length > 35;

      const charters = level.levelCredits?.filter(credit => credit.role === 'charter').map(credit => credit.creator?.name) || [];
      const vfxers = level.levelCredits?.filter(credit => credit.role === 'vfxer').map(credit => credit.creator?.name) || [];

      const firstRow = level.teamObject ? "By " + level.teamObject.name :   
        vfxers?.length > 0 ?
        "Chart: " + charters.join(', ')
        : 
           charters?.length > 4 ?
            "By " + charters.slice(0, 4).join(', ') + " and " + (charters.length - 4) + " more"
            : "By " + charters.join(', ');

      const secondRow = !level.teamObject 
      && vfxers.length > 0 && charters.length > 0
      ? "VFX: " + vfxers.join(', ')
      : "";

      const html = `
        <html>
          <head>
            <style>
              body { 
                margin: 0; 
                padding: 0;
                width: ${width}px;
                height: ${height}px;
                
                position: relative;
                overflow: hidden;
                font-family: 'NotoSansKR', 'NotoSansJP', 'NotoSansSC', 'NotoSansTC', sans-serif;
              .text {
                overflow: hidden;
                display: -webkit-box;
                -webkit-line-clamp: 2;
                -webkit-box-orient: vertical;
                max-width: ${520*multiplier}px;
              }
              .background-image {
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                object-fit: cover;
                z-index: 1;
              }
              .header {
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: ${(110 + (artistOverflow && songOverflow ? 10 : 0))*multiplier}px;
                background-color: rgba(0, 0, 0, 0.8);
                z-index: 2;
                display: flex;
                align-items: center;
                padding: 0 ${25*multiplier}px;
                box-sizing: border-box;
              }
              .header-left {
                display: flex;
                align-items: center;
                flex: 1;
              }
              .header-right {
                display: flex;
                padding-top: ${12*multiplier}px;
                align-self: start;
                align-items: center;
                justify-content: flex-end;
              }
              .difficulty-icon {
                width: ${iconSize}px;
                height: ${iconSize}px;
                margin-right: ${25*multiplier}px;
              }
              .song-info {
                display: flex;
                gap: ${5*multiplier}px;
                flex-direction: column;
                justify-content: center;
              }
              .song-title {
                font-weight: 800;
                font-size: ${35*multiplier*(songOverflow ? 0.8 : 1)}px;
                color: white;
                margin: 0;
                line-height: 1.2;
              }
              .artist-name {
                font-weight: 400;
                font-size: ${25*multiplier*(artistOverflow ? 0.8 : 1)}px;
                color: white;
                margin: 0;
                line-height: 1.2;
              }
              .level-id {
                font-weight: 700;
                font-size: ${40*multiplier}px;
                color: #bbbbbb;
              }
              .footer {
                position: absolute;
                bottom: 0;
                left: 0;
                width: 100%;
                height: ${110*multiplier}px;
                background-color: rgba(0, 0, 0, 0.8);
                z-index: 2;
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: ${10*multiplier}px ${25*multiplier}px;
                box-sizing: border-box;
              }
              .footer-left {
                display: flex;
                align-items: start;
                flex-direction: column;
              }
              .footer-right {
                  display: flex;
                  max-width: 70%;
                  gap: ${10*multiplier}px;
                  flex-direction: column;
              }
              .pp-value, .pass-count {
                font-weight: 700;
                font-size: ${30*multiplier}px;
                color: #bbbbbb;
              }
              .creator-name {
                font-weight: 600;
                text-align: right;
                font-size: ${30*multiplier*(secondRow ? 0.9 : 1)}px;
                color: white;
              }
            </style>
          </head>
          <body>
            <!-- Background image -->
            <img 
              class="background-image"
              src="data:image/png;base64,${backgroundBuffer.toString('base64')}" 
              alt="Background"
            />
            
            <!-- Header -->
            <div class="header">
              <div class="header-left">
                <img 
                  class="difficulty-icon"
                  src="data:image/png;base64,${iconBuffer.toString('base64')}" 
                  alt="Difficulty Icon"
                />
                <div class="song-info">
                  <div class="song-title text">${song}</div>
                  <div class="artist-name text" 
                    style="-webkit-line-clamp: 1">${artist}</div>
                </div>
              </div>
              <div class="header-right">
                <div class="level-id">#${levelId}</div>
              </div>
            </div>
            
            <!-- Footer -->
            <div class="footer">
              <div class="footer-left">
                <div class="pp-value">${level.baseScore || diff.baseScore || 0}PP</div>
                <div class="pass-count">${level.passes?.length || 0} pass${(level.passes?.length || 0) === 1 ? '' : 'es'}</div>
              </div>
              <div class="footer-right">
                <div class="creator-name">${firstRow}</div>
                ${secondRow ? `<div class="creator-name">${secondRow}</div>` : ''}
              </div>
            </div>
          </body>
        </html>
      `;
      // Convert to PNG
      largeBuffer = await htmlToPng(html, width, height);
      
      // Save the LARGE version to cache
      await fs.promises.writeFile(largeCachePath, largeBuffer)
      logger.debug(`Saved LARGE thumbnail for level ${levelId} to cache`);
    }

    // If LARGE was requested, just pipe the existing file
    if (size === 'LARGE') {
      res.set('Content-Type', 'image/png');
      return res.send(largeBuffer);
    }

    // Resize for other sizes on-the-fly
    const {width, height} = THUMBNAIL_SIZES[size];
    const resizedBuffer = await sharp(largeBuffer)
      .resize(width, height, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      })
      .png()
      .toBuffer();

    // Send the response
    res.set('Content-Type', 'image/png');
    res.send(resizedBuffer);
    
    logger.debug(`Memory usage after generation`);
    checkMemoryUsage();
    return;
  } catch (error) {
    if (typeof error === 'string' && error.startsWith("ProtocolError")) {
      console.error(`Error generating image for level ${req.params.levelId} due to browser protocol error`);
      return res.status(500).send('Generation failed: browser protocol error');
    }
    console.error(`Error generating image for level ${req.params.levelId}:`, error);
    console.error(`Error details:`, {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : 'No stack trace available',
    });
    return res.status(500).send('Error generating image');
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

    // Convert SVG to PNG using Puppeteer
    const html = `
      <html>
        <head>
          <style>
            body { margin: 0; }
          </style>
        </head>
        <body>
          ${svg}
        </body>
      </html>
    `;

    const buffer = await htmlToPng(html, width, height);

    res.set('Content-Type', 'image/png');
    return res.send(buffer);
  } catch (error) {
    console.error('Error generating wheel image:', error);
    return res.status(500).send('Error generating wheel image');
  }
});


export default router;