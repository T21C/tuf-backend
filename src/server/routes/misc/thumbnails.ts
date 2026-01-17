import express, {Request, Response, Router} from 'express';
import axios from 'axios';
import path from 'path';
import fs from 'fs';
import {Buffer} from 'buffer';
import sharp from 'sharp';
import Level from '../../../models/levels/Level.js';
import Difficulty from '../../../models/levels/Difficulty.js';
import LevelCredit from '../../../models/levels/LevelCredit.js';
import Creator from '../../../models/credits/Creator.js';
import { CreatorAlias } from '../../../models/credits/CreatorAlias.js';
import Team from '../../../models/credits/Team.js';
import { TeamAlias } from '../../../models/credits/TeamAlias.js';
import Curation from '../../../models/curations/Curation.js';
import CurationType from '../../../models/curations/CurationType.js';
import Rating from '../../../models/levels/Rating.js';
import Player from '../../../models/players/Player.js';
import Pass from '../../../models/passes/Pass.js';
import PlayerStats from '../../../models/players/PlayerStats.js';
import { LevelPack, LevelPackItem } from '../../../models/packs/index.js';
import { User } from '../../../models/index.js';
import { port } from '../../../config/app.config.js';
import CdnService from '../../services/CdnService.js';
import { logger } from '../../services/LoggerService.js';
import { formatCredits } from '../../../misc/utils/Utility.js';
import { htmlToPng, formatAxiosError } from './media.js';
import { formatNumber } from '../webhooks/embeds.js';
import dotenv from 'dotenv';

dotenv.config();

const CACHE_PATH = process.env.CACHE_PATH || path.join(process.cwd(), 'cache');

// Promise map for tracking ongoing thumbnail generation
const thumbnailGenerationPromises = new Map<string, Promise<Buffer>>();

// Define size presets
const THUMBNAIL_SIZES = {
  SMALL: {width: 400, height: 210, multiplier: 0.5}, // 16:9 ratio
  MEDIUM: {width: 800, height: 420, multiplier: 1},
  LARGE: {width: 1200, height: 630, multiplier: 1.5},
} as const;

// Cache directories
const THUMBNAILS_CACHE_DIR = process.env.THUMBNAILS_CACHE_PATH || path.join(CACHE_PATH, 'thumbnails');

// Ensure cache directories exist
[THUMBNAILS_CACHE_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Cache TTL in milliseconds (20 seconds) for development, 48 hours for production
const CACHE_TTL = process.env.NODE_ENV === 'production' ? 48 * 60 * 60 * 1000 : 20 * 1000;

// Cleanup interval in milliseconds (5 minutes)
const CLEANUP_INTERVAL = 5 * 60 * 1000;

function logWithCondition(message: string, source: string): void {
  if (source === 'thumbnail' && 1!==1) {
    logger.debug('[Thumbnail] ' + message);
  }
}

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

  // Also clean up any stale promises that might be hanging around
  const now = Date.now();
  const MAX_PROMISE_AGE = 5 * 60 * 1000; // 5 minutes

  // Add timestamp to promises if not present
  for (const [key, promise] of thumbnailGenerationPromises.entries()) {
    if (!(promise as any).__timestamp) {
      (promise as any).__timestamp = now;
    } else if (now - (promise as any).__timestamp > MAX_PROMISE_AGE) {
      // Clean up promises older than MAX_PROMISE_AGE
      logger.debug(`Removing stale thumbnail generation promise for ${key}`);
      thumbnailGenerationPromises.delete(key);
    }
  }
}

// Start periodic cleanup
setInterval(cleanAllExpiredCache, CLEANUP_INTERVAL);

// Run initial cleanup
cleanAllExpiredCache();

// Function to get cached thumbnail path
function getThumbnailPath(levelId: number, size: keyof typeof THUMBNAIL_SIZES): string {
  return path.join(THUMBNAILS_CACHE_DIR, `${levelId}_${size}.png`);
}

// Function to get cached thumbnail path for player/pass/pack
function getThumbnailPathForEntity(entityId: number, entityType: 'player' | 'pass' | 'pack', size: keyof typeof THUMBNAIL_SIZES): string {
  return path.join(THUMBNAILS_CACHE_DIR, `${entityType}_${entityId}_${size}.png`);
}

// Helper function to resolve pack ID from parameter (supports both numerical ID and linkCode)
async function resolvePackId(param: string): Promise<number | null> {
  if (/^[A-Za-z0-9]+$/.test(param)) {
    const pack = await LevelPack.findOne({
      where: { linkCode: param }
    });

    if (pack) {
      return pack.id;
    }
  }

  // Try as numeric ID
  const numericId = parseInt(param);
  if (!isNaN(numericId)) {
    return numericId;
  }

  return null;
}

// Function to export HTML to file for review
async function exportHtmlToFile(html: string, entityType: 'level' | 'player' | 'pass' | 'pack', entityId: number): Promise<void> {
  const htmlExportDir = path.join(CACHE_PATH, 'thumbnail-html-exports');
  if (!fs.existsSync(htmlExportDir)) {
    fs.mkdirSync(htmlExportDir, { recursive: true });
  }
  const htmlPath = path.join(htmlExportDir, `${entityType}_${entityId}.html`);
  await fs.promises.writeFile(htmlPath, html);
  logger.debug(`Exported HTML for ${entityType} ${entityId} to ${htmlPath}`);
}

// Helper function for retrying image downloads
async function downloadImageWithRetry(url: string, maxRetries = 5, delayMs = 5000): Promise<Buffer> {
  let lastError: Error | unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      logWithCondition(`Attempting to download image from ${url} (attempt ${attempt}/${maxRetries})`, 'thumbnail');
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 10000, // 10 second timeout
        maxContentLength: 10 * 1024 * 1024, // 10MB max
        maxBodyLength: 10 * 1024 * 1024, // 10MB max
      });
      logWithCondition(`Successfully downloaded image from ${url} on attempt ${attempt}`, 'thumbnail');
      return response.data;
    } catch (error: unknown) {
      lastError = error;
      logWithCondition(`Failed to download image from ${url} on attempt ${attempt}/${maxRetries}: ${formatAxiosError(error)}`, 'thumbnail');

      if (attempt < maxRetries) {
        logWithCondition(`Waiting ${delayMs}ms before retrying...`, 'thumbnail');
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }

  logWithCondition(`All ${maxRetries} attempts to download image from ${url} failed. Using black background instead.`, 'thumbnail');
  throw lastError;
}

const router: Router = express.Router();

// Level thumbnail route
router.get('/thumbnail/level/:levelId([0-9]{1,20})', async (req: Request, res: Response) => {
  const levelId = parseInt(req.params.levelId);
  try {
    const size = (req.query.size as keyof typeof THUMBNAIL_SIZES) || 'MEDIUM';
    const level = await Level.findByPk(levelId);
    if (!level || level.isDeleted || level.isHidden) {
      return res.status(404).send('Level not found');
    }

    logWithCondition(`Thumbnail requested for level ${levelId} with size ${size}`, 'thumbnail');

    // Get the cache path for LARGE version only
    const largeCachePath = getThumbnailPath(levelId, 'LARGE');
    const promiseKey = `level-${levelId}`;

    // Clean expired cache file
    cleanExpiredCache(largeCachePath);

    // Check if we have a valid cached LARGE version
    let largeBuffer: Buffer | undefined;
    if (fs.existsSync(largeCachePath) && !isCacheExpired(largeCachePath)) {
      logWithCondition(`Using cached LARGE thumbnail for level ${levelId}`, 'thumbnail');
      largeBuffer = await fs.promises.readFile(largeCachePath);
    } else {
      // Check if generation is already in progress
      if (thumbnailGenerationPromises.has(promiseKey)) {
        logWithCondition(`Thumbnail generation for level ${levelId} already in progress, waiting...`, 'thumbnail');
        try {
          largeBuffer = await thumbnailGenerationPromises.get(promiseKey)!;

          // Verify the file was actually saved
          if (!fs.existsSync(largeCachePath)) {
            logger.warn(`Promise resolved but thumbnail file not found for level ${levelId}, regenerating...`);
            // Remove the promise and continue to regeneration
            thumbnailGenerationPromises.delete(promiseKey);
          } else {
            logWithCondition(`Successfully obtained thumbnail from concurrent generation for level ${levelId}`, 'thumbnail');
          }
        } catch (error) {
          if (error instanceof Error && !error.message.includes('Video details not found')) {
            logger.warn(`Error while waiting for concurrent thumbnail generation for level ${levelId}:`, error);
          }
          thumbnailGenerationPromises.delete(promiseKey);
        }
      }

      // If we don't have the buffer yet (no concurrent generation or it failed)
      if (!largeBuffer) {
        // Create a new generation promise
        const generationPromise = (async () => {
          logWithCondition(`Generating new thumbnail for level ${levelId}`, 'thumbnail');

          const level = await Level.findOne({
            where: {id: levelId},
            include: [
              {model: Curation, as: 'curation', include: [
                {model: CurationType, as: 'type', attributes: ['icon']}
              ]},
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
              {model: Rating, as: 'ratings', attributes: ['averageDifficultyId'], limit: 1, order: [['confirmedAt', 'DESC']]}
            ],
          });


          if (!level) {
            throw new Error('Level or difficulty not found');
          }

          const averageDifficulty = level?.ratings?.[0]?.averageDifficultyId && level.difficulty?.name[0] === "Q" ? await Difficulty.findByPk(level.ratings?.[0]?.averageDifficultyId) : undefined;

          const {song, artist, difficulty: diff} = level.dataValues;
          if (!diff) {
            throw new Error('Difficulty not found');
          }
          const [details, metadata] = await Promise.all([
          axios.get(`http://localhost:${port}/v2/media/video-details/${encodeURIComponent(level.videoLink)}`)
          .then(res => res.data).catch(() => undefined),
          CdnService.getLevelData(level, ['settings','angles','accessCount']).catch(() => undefined)
          ])

          // Generate the HTML and PNG for LARGE size
          const {width, height, multiplier} = THUMBNAIL_SIZES.LARGE;
          const iconSize = Math.floor(height * 0.184);

          // Download background image with retry logic
          let backgroundBuffer: Buffer;
          try {
            if (!details?.image) {
              throw new Error('Video details not found');
            }
            backgroundBuffer = await downloadImageWithRetry(details.image);
          } catch (error: unknown) {
            logWithCondition(`Failed to download background image after all retries for level ${levelId}: ${error instanceof Error ? error.message : String(error)}`, 'thumbnail');
            // Create a black background
            backgroundBuffer = await sharp({
              create: {
                width,
                height,
                channels: 4,
                background: {r: 0, g: 0, b: 0, alpha: 1},
              },
            })
              .png()
              .toBuffer();
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
            const basePath = path.join(CACHE_PATH, 'icons');
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
            logger.error(`Failed to get difficulty icon for level ${levelId}: ${error instanceof Error ? error.message : String(error)}`);
            // Create a placeholder icon
            iconBuffer = Buffer.alloc(iconSize * iconSize * 4, 100);
          }
          const artistOverflow = artist.length > 35;
          const songOverflow = song.length > 35;

          const charters = formatCredits(level.charters);
          const vfxers = formatCredits(level.vfxers);

          const firstRow = level.teamObject ? 'By ' + level.teamObject.name :
            charters ?
            'Chart: ' + charters
            :
              charters

          const secondRow = !level.teamObject
          && vfxers && charters
          ? 'VFX: ' + vfxers
          : '';

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
                    flex-direction: column;
                    padding-top: ${12*multiplier}px;
                    align-self: start;
                    align-items: center;
                    text-align: right;
                    justify-content: flex-end;
                  }
                  .difficulty-container {
                    position: relative;
                  }
                  .difficulty-icon {
                    width: ${iconSize}px;
                    height: ${iconSize}px;
                    margin-right: ${25*multiplier}px;
                  }
                  .curation-icon {
                  position: absolute;
                  bottom: -10%;
                  right: 15%;
                  width: ${Math.round(iconSize/2)}px;
                  height: ${Math.round(iconSize/2)}px;
                  filter: drop-shadow(0 0 3px rgba(0, 0, 0, 1));
                  z-index: 3;
                  }
                  .average-diff-icon {
                  position: absolute;
                  top: -10%;
                  left: -10%;
                  width: ${Math.round(iconSize/2)}px;
                  height: ${Math.round(iconSize/2)}px;
                  z-index: 3;
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
                    align-self: flex-end;
                    font-size: ${40*multiplier}px;
                    color: #bbbbbb;
                  }
                  .level-metadata {
                    display: flex;
                    margin-top: ${7*multiplier}px;
                    gap: ${10*multiplier}px;
                  }
                  .level-metadata.hidden {
                    display: none;
                  }

                  .level-metadata-item {
                    display: flex;
                    align-items: center;
                    gap: ${5*multiplier}px;
                  }
                  .level-metadata-item-text {
                    font-weight: 700;
                    font-size: ${20*multiplier}px;
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
                    <div class="difficulty-container">
                    <img 
                      class="difficulty-icon"
                      src="data:image/png;base64,${iconBuffer.toString('base64')}" 
                      alt="Difficulty Icon"
                    />
                    ${level.curation?.type?.icon ? `<img class="curation-icon" src="${level.curation?.type?.icon}" alt="Curation Icon">` : ''}
                    ${averageDifficulty ? `<img class="average-diff-icon" src="${averageDifficulty.icon}" alt="Average Difficulty Icon">` : ''}
                    </div>
                    <div class="song-info">
                      <div class="song-title text">${song}</div>
                      <div class="artist-name text" 
                        style="-webkit-line-clamp: 1">${artist}</div>
                    </div>
                  </div>
                  <div class="header-right">
                    <div class="level-id">#${levelId}</div>
                    <div class="level-metadata ${metadata?.angles?.length && metadata?.settings?.bpm ? '' : 'hidden'}">
                      <div class="level-metadata-item">

                          <svg width="${Math.round(24*multiplier)}px" height="${Math.round(24*multiplier)}px" version="1.1" id="Layer_1" xmlns="http://www.w3.org/2000/svg" xmlnsXlink="http://www.w3.org/1999/xlink" x="0px" y="0px" viewBox="0 0 612 612" enable-background="new 0 0 612 512">
                              <path 
                              fill="#bbbbbb" 
                              opacity="1.000000" 
                              stroke="none" 
                              d="M 605.441 217.577 C 604.88 218.138 590.048 233.969 585.902 238.23 C 576.142 248.26 566.275 258.192 556.526 268.231 C 543.405 281.742 530.306 295.273 517.284 308.877 C 502.558 324.264 487.938 339.747 473.252 355.174 C 462.662 366.298 452.097 377.445 441.423 388.489 C 431.586 398.666 421.587 408.685 411.718 418.832 C 397.816 433.124 383.736 447.263 370.264 461.941 C 366.843 465.667 363.621 466.384 359.072 466.381 C 246.224 466.288 133.375 466.307 20.078 466.307 C -4.426 466.307 -3.859 429.986 20.078 429.986 C 58.619 429.986 96.71 429.546 135.141 429.546 C 134.908 388.445 135.4 347.799 134.841 307.001 C 95.575 307.001 57.603 307.001 19.63 307.001 C -5.122 307.001 -4.209 271.622 19.63 271.622 C 102.456 271.622 185.28 271.174 268.104 271.212 C 270.971 271.213 272.931 270.735 275.188 268.327 C 286.374 256.393 298.033 244.893 309.496 233.213 C 317.974 224.573 326.431 215.914 334.855 207.223 C 348.295 193.36 361.696 179.454 375.124 165.578 C 389.321 150.908 403.531 136.248 417.733 121.582 C 431.493 107.369 444.75 92.661 458.718 78.692 C 479.23 58.181 513.204 85.403 491.311 107.296 C 484.207 114.4 477.386 121.781 470.366 128.968 C 460.031 139.545 449.6 150.032 439.301 160.646 C 432.415 167.742 425.686 174.988 418.747 182.32 C 419.477 183.321 420.218 184.66 421.254 185.716 C 433.381 198.078 445.613 210.34 457.697 222.741 C 470.402 235.778 483.05 248.875 495.555 262.099 C 498.284 264.985 499.955 264.988 502.713 262.111 C 513.49 250.865 524.562 239.898 535.417 228.727 C 547.553 216.238 559.262 203.391 571.604 191.048 C 595.827 166.827 624.701 198.316 605.441 217.577 Z M 398.889 228.73 C 395.613 225.169 392.289 221.647 389.075 218.034 C 387.306 216.043 385.802 216.017 384.009 218.015 C 380.569 221.849 377.077 225.646 373.499 229.357 C 359.655 243.717 345.798 258.067 331.88 272.36 C 321.452 283.072 311.007 293.77 300.359 304.264 C 298.819 305.78 296.09 306.88 293.907 306.889 C 255.107 307.042 216.304 307.001 177.504 307.001 C 175.825 307.001 174.146 307.001 172.603 307.001 C 172.603 348.181 172.603 388.782 172.603 429.546 C 174.628 429.546 176.362 429.546 178.097 429.546 C 229.938 429.546 281.782 430.368 333.616 429.807 C 343.224 429.703 345.821 424.945 354.967 415.508 C 360.753 409.538 366.435 403.465 372.22 397.492 C 386.867 382.367 401.503 367.232 416.215 352.17 C 428.096 340.005 440.108 327.964 452.007 315.813 C 456.278 311.455 460.304 306.861 464.607 302.534 C 466.407 300.724 466.672 299.496 464.798 297.492 C 455.64 287.689 446.806 277.583 437.516 267.909 C 424.973 254.849 412.115 242.084 398.889 228.73 Z"></path>
                            </svg>
                        <span class="level-metadata-item-text">${metadata?.angles?.length || 0}</span>
                      </div>
                      <div class="level-metadata-item">

                            <svg width="${Math.round(24*multiplier)}px" height="${Math.round(24*multiplier)}px" 
                            fill="#bbbbbb" viewBox="0 0 256 256" 
                            xmlns="http://www.w3.org/2000/svg" stroke="#bbbbbb">
                            <g id="SVGRepo_bgCarrier" strokeWidth="0"></g>
                            <g id="SVGRepo_tracerCarrier" strokeLinecap="round" strokeLinejoin="round"></g>
                            <g id="SVGRepo_iconCarrier"> <g fillRule="evenodd"> 
                            <path d="M64.458 228.867c-.428 2.167 1.007 3.91 3.226 3.893l121.557-.938c2.21-.017 3.68-1.794 3.284-3.97l-11.838-64.913c-.397-2.175-1.626-2.393-2.747-.487l-9.156 15.582c-1.12 1.907-1.71 5.207-1.313 7.388l4.915 27.03c.395 2.175-1.072 3.937-3.288 3.937H88.611c-2.211 0-3.659-1.755-3.233-3.92L114.85 62.533l28.44-.49 11.786 44.43c.567 2.139 2.01 2.386 3.236.535l8.392-12.67c1.22-1.843 1.73-5.058 1.139-7.185l-9.596-34.5c-1.184-4.257-5.735-7.677-10.138-7.638l-39.391.349c-4.415.039-8.688 3.584-9.544 7.912L64.458 228.867z"></path> <path d="M118.116 198.935c-1.182 1.865-.347 3.377 1.867 3.377h12.392c2.214 0 4.968-1.524 6.143-3.39l64.55-102.463c1.18-1.871 3.906-3.697 6.076-4.074l9.581-1.667c2.177-.379 4.492-2.38 5.178-4.496l4.772-14.69c.683-2.104-.063-5.034-1.677-6.555L215.53 54.173c-1.609-1.517-4.482-1.862-6.4-.78l-11.799 6.655c-1.925 1.086-3.626 3.754-3.799 5.954l-.938 11.967c-.173 2.202-1.27 5.498-2.453 7.363l-72.026 113.603z"></path> </g> </g></svg>
    
                        <span class="level-metadata-item-text">${metadata?.settings?.bpm || 0}</span>
                      </div>
                    </div>
                  </div>
                </div>
                
                <!-- Footer -->
                <div class="footer">
                  <div class="footer-left">
                    <div class="pp-value">${level.baseScore || diff.baseScore || 0}PP</div>
                    <div class="pass-count">${level.clears || 0} pass${(level.clears || 0) === 1 ? '' : 'es'}</div>
                  </div>
                  <div class="footer-right">
                    <div class="creator-name">${firstRow}</div>
                    ${secondRow ? `<div class="creator-name">${secondRow}</div>` : ''}
                  </div>
                </div>
              </body>
            </html>
          `;
          
          // Export HTML to file for review
          await exportHtmlToFile(html, 'level', levelId);
          
          // Convert to PNG
          const buffer = await htmlToPng(html, width, height);

          // Save the LARGE version to cache
          await fs.promises.writeFile(largeCachePath, buffer);
          logWithCondition(`Saved LARGE thumbnail for level ${levelId} to cache`, 'thumbnail');

          return buffer;
        })();

        // Store the promise in the map
        thumbnailGenerationPromises.set(promiseKey, generationPromise);

        try {
          // Wait for the generation to complete
          largeBuffer = await generationPromise;
        } catch (error) {
          // If any error occurs, clean up the promise and rethrow
          thumbnailGenerationPromises.delete(promiseKey);
          throw error;
        }

        // Clean up the promise after successful completion
        thumbnailGenerationPromises.delete(promiseKey);
      }
    }

    // Validate buffer exists and is valid
    if (!largeBuffer || largeBuffer.length === 0) {
      logger.error(`Invalid or empty buffer for level ${levelId}, regenerating...`);
      // Delete corrupted cache file if it exists
      if (fs.existsSync(largeCachePath)) {
        await fs.promises.unlink(largeCachePath).catch(() => {});
      }
      return res.status(500).send('Error generating image: invalid buffer');
    }

    // Validate PNG signature (89 50 4E 47 0D 0A 1A 0A)
    const pngSignature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    if (largeBuffer.length < 8 || !largeBuffer.subarray(0, 8).equals(pngSignature)) {
      logger.error(`Invalid PNG signature for level ${levelId}, regenerating...`);
      // Delete corrupted cache file
      if (fs.existsSync(largeCachePath)) {
        await fs.promises.unlink(largeCachePath).catch(() => {});
      }
      return res.status(500).send('Error generating image: invalid PNG format');
    }

    // If LARGE was requested, just pipe the existing file
    if (size === 'LARGE') {
      res.set('Content-Type', 'image/png');
      return res.send(largeBuffer);
    }

    // Resize for other sizes on-the-fly
    const {width, height} = THUMBNAIL_SIZES[size];
    let resizedBuffer: Buffer;
    try {
      resizedBuffer = await sharp(largeBuffer)
        .resize(width, height, {
          fit: 'contain',
          background: { r: 0, g: 0, b: 0, alpha: 0 }
        })
        .png()
        .toBuffer();
    } catch (sharpError) {
      // If Sharp fails to read the buffer, the cache file is likely corrupted
      logger.error(`Sharp error processing buffer for level ${levelId}: ${sharpError instanceof Error ? sharpError.message : String(sharpError)}`);
      // Delete corrupted cache file
      if (fs.existsSync(largeCachePath)) {
        await fs.promises.unlink(largeCachePath).catch(() => {});
      }
      throw sharpError;
    }

    // Send the response
    res.set('Content-Type', 'image/png');
    res.send(resizedBuffer);

    logWithCondition('Memory usage after generation', 'thumbnail');
    return;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Video details not found')) {
      logger.debug(`Error generating image for level ${req.params.levelId} due to missing video details`);
      return res.status(404).send('Generation failed: missing video details');
    }
    if (error instanceof Error && (error.message.startsWith('ProtocolError') || error.message.startsWith('Error: Protocol error'))) {
      logger.error(`Error generating image for level ${req.params.levelId} due to puppeteer protocol error`);
      return res.status(500).send('Generation failed: puppeteer protocol error');
    }
    if (error instanceof Error && error.message.includes('pngload_buffer')) {
      const levelId = parseInt(req.params.levelId);
      logger.error(`PNG loading error for level ${levelId}, deleting corrupted cache and regenerating...`);
      const largeCachePath = getThumbnailPath(levelId, 'LARGE');
      if (fs.existsSync(largeCachePath)) {
        await fs.promises.unlink(largeCachePath).catch(() => {});
      }
      return res.status(500).send('Error generating image: corrupted cache file');
    }
    logger.error(`Error generating image for level ${req.params.levelId}:`, error);
    return res.status(500).send('Error generating image');
  }
});

// Player thumbnail route
router.get('/thumbnail/player/:id([0-9]{1,20})', async (req: Request, res: Response) => {
  try {
    const size = (req.query.size as keyof typeof THUMBNAIL_SIZES) || 'MEDIUM';
    const playerId = parseInt(req.params.id);
    const player = await Player.findByPk(playerId, {
      include: [
        {model: PlayerStats, as: 'stats'}
      ]
    });
    const difficulties = await Difficulty.findAll();
    const difficultyMap = new Map<number, string>(difficulties.map(difficulty => [difficulty.id, difficulty.name]));
    
    if (!player) {
      return res.status(404).send('Player not found');
    }

    logWithCondition(`Thumbnail requested for player ${playerId} with size ${size}`, 'thumbnail');

    const largeCachePath = getThumbnailPathForEntity(playerId, 'player', 'LARGE');
    const promiseKey = `player-${playerId}`;

    cleanExpiredCache(largeCachePath);

    let largeBuffer: Buffer | undefined;
    if (fs.existsSync(largeCachePath) && !isCacheExpired(largeCachePath)) {
      logWithCondition(`Using cached LARGE thumbnail for player ${playerId}`, 'thumbnail');
      largeBuffer = await fs.promises.readFile(largeCachePath);
    } else {
      if (thumbnailGenerationPromises.has(promiseKey)) {
        logWithCondition(`Thumbnail generation for player ${playerId} already in progress, waiting...`, 'thumbnail');
        try {
          largeBuffer = await thumbnailGenerationPromises.get(promiseKey)!;
          if (!fs.existsSync(largeCachePath)) {
            logger.warn(`Promise resolved but thumbnail file not found for player ${playerId}, regenerating...`);
            thumbnailGenerationPromises.delete(promiseKey);
          } else {
            logWithCondition(`Successfully obtained thumbnail from concurrent generation for player ${playerId}`, 'thumbnail');
          }
        } catch (error) {
          logger.warn(`Error while waiting for concurrent thumbnail generation for player ${playerId}:`, error);
          thumbnailGenerationPromises.delete(promiseKey);
        }
      }

      if (!largeBuffer) {
        const generationPromise = (async () => {
          logWithCondition(`Generating new thumbnail for player ${playerId}`, 'thumbnail');

          const {width, height, multiplier} = THUMBNAIL_SIZES.LARGE;

          // Create a simple background
          const backgroundBuffer = await sharp({
            create: {
              width,
              height,
              channels: 4,
              background: {r: 30, g: 30, b: 40, alpha: 1},
            },
          })
            .png()
            .toBuffer();

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
                  .content {
                    position: absolute;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    z-index: 2;
                    display: flex;
                    flex-direction: column;
                    justify-content: center;
                    align-items: center;
                    background-color: rgba(0, 0, 0, 0.6);
                    padding: ${40*multiplier}px;
                    box-sizing: border-box;
                  }
                  .player-name {
                    font-weight: 800;
                    font-size: ${50*multiplier}px;
                    color: white;
                    margin-bottom: ${20*multiplier}px;
                    text-align: center;
                  }
                  .player-rank {
                    font-weight: 700;
                    font-size: ${30*multiplier}px;
                    color: #bbbbbb;
                    margin-bottom: ${30*multiplier}px;
                  }
                  .stats {
                    display: flex;
                    flex-direction: column;
                    gap: ${15*multiplier}px;
                    width: 100%;
                    max-width: ${600*multiplier}px;
                  }
                  .stat-item {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: ${10*multiplier}px ${20*multiplier}px;
                    background-color: rgba(255, 255, 255, 0.1);
                    border-radius: ${8*multiplier}px;
                  }
                  .stat-label {
                    font-weight: 600;
                    font-size: ${25*multiplier}px;
                    color: #bbbbbb;
                  }
                  .stat-value {
                    font-weight: 700;
                    font-size: ${25*multiplier}px;
                    color: white;
                  }
                </style>
              </head>
              <body>
                <img 
                  class="background-image"
                  src="data:image/png;base64,${backgroundBuffer.toString('base64')}" 
                  alt="Background"
                />
                <div class="content">
                  <div class="player-name">${player.name}</div>
                  <div class="player-rank">#${player.stats?.rankedScoreRank || 0}</div>
                  <div class="stats">
                    <div class="stat-item">
                      <span class="stat-label">Total Passes:</span>
                      <span class="stat-value">${player.stats?.totalPasses || 0}</span>
                    </div>
                    <div class="stat-item">
                      <span class="stat-label">Ranked Score:</span>
                      <span class="stat-value">${formatNumber(player.stats?.rankedScore || 0)}</span>
                    </div>
                    <div class="stat-item">
                      <span class="stat-label">Top Difficulty:</span>
                      <span class="stat-value">${difficultyMap.get(player.stats?.topDiffId || 0) || 'None'}</span>
                    </div>
                  </div>
                </div>
              </body>
            </html>
          `;

          // Export HTML to file for review
          await exportHtmlToFile(html, 'player', playerId);

          const buffer = await htmlToPng(html, width, height);
          await fs.promises.writeFile(largeCachePath, buffer);
          logWithCondition(`Saved LARGE thumbnail for player ${playerId} to cache`, 'thumbnail');

          return buffer;
        })();

        thumbnailGenerationPromises.set(promiseKey, generationPromise);

        try {
          largeBuffer = await generationPromise;
        } catch (error) {
          thumbnailGenerationPromises.delete(promiseKey);
          throw error;
        }

        thumbnailGenerationPromises.delete(promiseKey);
      }
    }

    // Validate buffer exists and is valid
    if (!largeBuffer || largeBuffer.length === 0) {
      logger.error(`Invalid or empty buffer for player ${playerId}, regenerating...`);
      if (fs.existsSync(largeCachePath)) {
        await fs.promises.unlink(largeCachePath).catch(() => {});
      }
      return res.status(500).send('Error generating image: invalid buffer');
    }

    // Validate PNG signature
    const pngSignature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    if (largeBuffer.length < 8 || !largeBuffer.subarray(0, 8).equals(pngSignature)) {
      logger.error(`Invalid PNG signature for player ${playerId}, regenerating...`);
      if (fs.existsSync(largeCachePath)) {
        await fs.promises.unlink(largeCachePath).catch(() => {});
      }
      return res.status(500).send('Error generating image: invalid PNG format');
    }

    if (size === 'LARGE') {
      res.set('Content-Type', 'image/png');
      return res.send(largeBuffer);
    }

    const {width, height} = THUMBNAIL_SIZES[size];
    let resizedBuffer: Buffer;
    try {
      resizedBuffer = await sharp(largeBuffer)
        .resize(width, height, {
          fit: 'contain',
          background: { r: 0, g: 0, b: 0, alpha: 0 }
        })
        .png()
        .toBuffer();
    } catch (sharpError) {
      logger.error(`Sharp error processing buffer for player ${playerId}: ${sharpError instanceof Error ? sharpError.message : String(sharpError)}`);
      if (fs.existsSync(largeCachePath)) {
        await fs.promises.unlink(largeCachePath).catch(() => {});
      }
      throw sharpError;
    }

    res.set('Content-Type', 'image/png');
    res.send(resizedBuffer);
    return;
  } catch (error) {
    logger.error(`Error generating image for player ${req.params.id}:`, error);
    return res.status(500).send('Error generating image');
  }
});

// Pass thumbnail route
router.get('/thumbnail/pass/:id([0-9]{1,20})', async (req: Request, res: Response) => {
  try {
    const size = (req.query.size as keyof typeof THUMBNAIL_SIZES) || 'MEDIUM';
    const passId = parseInt(req.params.id);
    const pass = await Pass.findByPk(passId, {
      include: [
        {model: Level, as: 'level', include: [
          {model: Difficulty, as: 'difficulty'}
        ]},
        {model: Player, as: 'player'}
      ]
    });
    
    if (!pass || pass.isDeleted || pass.isHidden) {
      return res.status(404).send('Pass not found');
    }

    logWithCondition(`Thumbnail requested for pass ${passId} with size ${size}`, 'thumbnail');

    const largeCachePath = getThumbnailPathForEntity(passId, 'pass', 'LARGE');
    const promiseKey = `pass-${passId}`;

    cleanExpiredCache(largeCachePath);

    let largeBuffer: Buffer | undefined;
    if (fs.existsSync(largeCachePath) && !isCacheExpired(largeCachePath)) {
      logWithCondition(`Using cached LARGE thumbnail for pass ${passId}`, 'thumbnail');
      largeBuffer = await fs.promises.readFile(largeCachePath);
    } else {
      if (thumbnailGenerationPromises.has(promiseKey)) {
        logWithCondition(`Thumbnail generation for pass ${passId} already in progress, waiting...`, 'thumbnail');
        try {
          largeBuffer = await thumbnailGenerationPromises.get(promiseKey)!;
          if (!fs.existsSync(largeCachePath)) {
            logger.warn(`Promise resolved but thumbnail file not found for pass ${passId}, regenerating...`);
            thumbnailGenerationPromises.delete(promiseKey);
          } else {
            logWithCondition(`Successfully obtained thumbnail from concurrent generation for pass ${passId}`, 'thumbnail');
          }
        } catch (error) {
          logger.warn(`Error while waiting for concurrent thumbnail generation for pass ${passId}:`, error);
          thumbnailGenerationPromises.delete(promiseKey);
        }
      }

      if (!largeBuffer) {
        const generationPromise = (async () => {
          logWithCondition(`Generating new thumbnail for pass ${passId}`, 'thumbnail');

          const {width, height, multiplier} = THUMBNAIL_SIZES.LARGE;

          // Create a simple background
          const backgroundBuffer = await sharp({
            create: {
              width,
              height,
              channels: 4,
              background: {r: 40, g: 30, b: 30, alpha: 1},
            },
          })
            .png()
            .toBuffer();

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
                  .content {
                    position: absolute;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    z-index: 2;
                    display: flex;
                    flex-direction: column;
                    justify-content: center;
                    align-items: center;
                    background-color: rgba(0, 0, 0, 0.6);
                    padding: ${40*multiplier}px;
                    box-sizing: border-box;
                  }
                  .pass-id {
                    font-weight: 700;
                    font-size: ${40*multiplier}px;
                    color: #bbbbbb;
                    margin-bottom: ${20*multiplier}px;
                  }
                  .level-info {
                    font-weight: 800;
                    font-size: ${45*multiplier}px;
                    color: white;
                    margin-bottom: ${15*multiplier}px;
                    text-align: center;
                  }
                  .player-info {
                    font-weight: 600;
                    font-size: ${35*multiplier}px;
                    color: #bbbbbb;
                    margin-bottom: ${30*multiplier}px;
                  }
                  .stats {
                    display: flex;
                    flex-direction: column;
                    gap: ${15*multiplier}px;
                    width: 100%;
                    max-width: ${600*multiplier}px;
                  }
                  .stat-item {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: ${10*multiplier}px ${20*multiplier}px;
                    background-color: rgba(255, 255, 255, 0.1);
                    border-radius: ${8*multiplier}px;
                  }
                  .stat-label {
                    font-weight: 600;
                    font-size: ${25*multiplier}px;
                    color: #bbbbbb;
                  }
                  .stat-value {
                    font-weight: 700;
                    font-size: ${25*multiplier}px;
                    color: white;
                  }
                </style>
              </head>
              <body>
                <img 
                  class="background-image"
                  src="data:image/png;base64,${backgroundBuffer.toString('base64')}" 
                  alt="Background"
                />
                <div class="content">
                  <div class="pass-id">Pass #${passId}</div>
                  <div class="level-info">${pass.level?.song || 'Unknown Level'}</div>
                  <div class="player-info">by ${pass.player?.name || 'Unknown Player'}</div>
                  <div class="stats">
                    ${pass.scoreV2 !== null ? `
                    <div class="stat-item">
                      <span class="stat-label">Score:</span>
                      <span class="stat-value">${formatNumber(pass.scoreV2)}</span>
                    </div>
                    ` : ''}
                    ${pass.accuracy !== null ? `
                    <div class="stat-item">
                      <span class="stat-label">Accuracy:</span>
                      <span class="stat-value">${(pass.accuracy * 100).toFixed(2)}%</span>
                    </div>
                    ` : ''}
                    ${pass.speed !== null ? `
                    <div class="stat-item">
                      <span class="stat-label">Speed:</span>
                      <span class="stat-value">${pass.speed}x</span>
                    </div>
                    ` : ''}
                  </div>
                </div>
              </body>
            </html>
          `;

          // Export HTML to file for review
          await exportHtmlToFile(html, 'pass', passId);

          const buffer = await htmlToPng(html, width, height);
          await fs.promises.writeFile(largeCachePath, buffer);
          logWithCondition(`Saved LARGE thumbnail for pass ${passId} to cache`, 'thumbnail');

          return buffer;
        })();

        thumbnailGenerationPromises.set(promiseKey, generationPromise);

        try {
          largeBuffer = await generationPromise;
        } catch (error) {
          thumbnailGenerationPromises.delete(promiseKey);
          throw error;
        }

        thumbnailGenerationPromises.delete(promiseKey);
      }
    }

    // Validate buffer exists and is valid
    if (!largeBuffer || largeBuffer.length === 0) {
      logger.error(`Invalid or empty buffer for pass ${passId}, regenerating...`);
      if (fs.existsSync(largeCachePath)) {
        await fs.promises.unlink(largeCachePath).catch(() => {});
      }
      return res.status(500).send('Error generating image: invalid buffer');
    }

    // Validate PNG signature
    const pngSignature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    if (largeBuffer.length < 8 || !largeBuffer.subarray(0, 8).equals(pngSignature)) {
      logger.error(`Invalid PNG signature for pass ${passId}, regenerating...`);
      if (fs.existsSync(largeCachePath)) {
        await fs.promises.unlink(largeCachePath).catch(() => {});
      }
      return res.status(500).send('Error generating image: invalid PNG format');
    }

    if (size === 'LARGE') {
      res.set('Content-Type', 'image/png');
      return res.send(largeBuffer);
    }

    const {width, height} = THUMBNAIL_SIZES[size];
    let resizedBuffer: Buffer;
    try {
      resizedBuffer = await sharp(largeBuffer)
        .resize(width, height, {
          fit: 'contain',
          background: { r: 0, g: 0, b: 0, alpha: 0 }
        })
        .png()
        .toBuffer();
    } catch (sharpError) {
      logger.error(`Sharp error processing buffer for pass ${passId}: ${sharpError instanceof Error ? sharpError.message : String(sharpError)}`);
      if (fs.existsSync(largeCachePath)) {
        await fs.promises.unlink(largeCachePath).catch(() => {});
      }
      throw sharpError;
    }

    res.set('Content-Type', 'image/png');
    res.send(resizedBuffer);
    return;
  } catch (error) {
    logger.error(`Error generating image for pass ${req.params.id}:`, error);
    return res.status(500).send('Error generating image');
  }
});

// Pack thumbnail route
router.get('/thumbnail/pack/:id([0-9A-Za-z]+)', async (req: Request, res: Response) => {
  try {
    const size = (req.query.size as keyof typeof THUMBNAIL_SIZES) || 'MEDIUM';
    const param = req.params.id;
    const resolvedPackId = await resolvePackId(param);
    
    if (!resolvedPackId) {
      return res.status(404).send('Pack not found');
    }

    const pack = await LevelPack.findByPk(resolvedPackId, {
      include: [
        {
          model: User,
          as: 'packOwner',
          attributes: ['id', 'nickname', 'username', 'avatarUrl']
        },
        {
          model: LevelPackItem,
          as: 'packItems',
          attributes: ['levelId', 'sortOrder'],
          where: {
            type: 'level'
          },
          include: [{
            model: Level,
            as: 'referencedLevel',
            where: {
              isDeleted: false,
              isHidden: false
            },
            attributes: ['id', 'artist', 'song', 'diffId'],
            required: true,
            include: [{
              model: Difficulty,
              as: 'difficulty',
              attributes: ['icon'],
              required: false
            }]
          }],
          required: false,
          limit: 3,
          order: [['sortOrder', 'ASC']]
        }
      ]
    });

    if (!pack) {
      return res.status(404).send('Pack not found');
    }

    logWithCondition(`Thumbnail requested for pack ${resolvedPackId} with size ${size}`, 'thumbnail');

    const largeCachePath = getThumbnailPathForEntity(resolvedPackId, 'pack', 'LARGE');
    const promiseKey = `pack-${resolvedPackId}`;

    cleanExpiredCache(largeCachePath);

    let largeBuffer: Buffer | undefined;
    if (fs.existsSync(largeCachePath) && !isCacheExpired(largeCachePath)) {
      logWithCondition(`Using cached LARGE thumbnail for pack ${resolvedPackId}`, 'thumbnail');
      largeBuffer = await fs.promises.readFile(largeCachePath);
    } else {
      if (thumbnailGenerationPromises.has(promiseKey)) {
        logWithCondition(`Thumbnail generation for pack ${resolvedPackId} already in progress, waiting...`, 'thumbnail');
        try {
          largeBuffer = await thumbnailGenerationPromises.get(promiseKey)!;
          if (!fs.existsSync(largeCachePath)) {
            logger.warn(`Promise resolved but thumbnail file not found for pack ${resolvedPackId}, regenerating...`);
            thumbnailGenerationPromises.delete(promiseKey);
          } else {
            logWithCondition(`Successfully obtained thumbnail from concurrent generation for pack ${resolvedPackId}`, 'thumbnail');
          }
        } catch (error) {
          logger.warn(`Error while waiting for concurrent thumbnail generation for pack ${resolvedPackId}:`, error);
          thumbnailGenerationPromises.delete(promiseKey);
        }
      }

      if (!largeBuffer) {
        const generationPromise = (async () => {
          logWithCondition(`Generating new thumbnail for pack ${resolvedPackId}`, 'thumbnail');

          const {width, height, multiplier} = THUMBNAIL_SIZES.LARGE;
          const iconSize = Math.floor(height * 0.3);

          // Get level items (already limited to 3)
          const levelItems = pack.packItems?.filter(item => item.referencedLevel !== null) || [];
          const totalLevelCount = pack.levelCount || 0;
          const remainingCount = Math.max(0, totalLevelCount - 3);

          // Download pack icon with retry logic
          let iconBuffer: Buffer | null = null;
          let hasIcon = false;
          try {
            if (pack.iconUrl) {
              iconBuffer = await downloadImageWithRetry(pack.iconUrl);
              hasIcon = true;
            } else {
              throw new Error('No pack icon');
            }
          } catch (error: unknown) {
            logWithCondition(`Failed to download pack icon for pack ${resolvedPackId}: ${error instanceof Error ? error.message : String(error)}`, 'thumbnail');
            hasIcon = false;
          }

          // Download owner avatar
          let ownerAvatarBuffer: Buffer | null = null;
          const ownerAvatarUrl = (pack as any).packOwner?.avatarUrl;
          try {
            if (ownerAvatarUrl) {
              ownerAvatarBuffer = await downloadImageWithRetry(ownerAvatarUrl);
            }
          } catch (error: unknown) {
            logWithCondition(`Failed to download owner avatar for pack ${resolvedPackId}: ${error instanceof Error ? error.message : String(error)}`, 'thumbnail');
          }

          // Create background
          const backgroundBuffer = await sharp({
            create: {
              width,
              height,
              channels: 4,
              background: {r: 26, g: 26, b: 26, alpha: 1},
            },
          })
            .png()
            .toBuffer();

          // Build level list HTML
          let levelsHtml = '';
          levelItems.forEach((item, index) => {
            const level = item.referencedLevel;
            if (!level) return;
            
            const diffIcon = level.difficulty?.icon || '';
            const songName = level.song || `Level ${level.id}`;
            levelsHtml += `
              <div class="level-item">
                ${diffIcon ? `<img class="level-item-icon" src="${diffIcon}" alt="Difficulty Icon" />` : ''}
                <span class="level-item-name">${songName}</span>
              </div>
            `;
          });

          if (remainingCount > 0) {
            levelsHtml += `
              <div class="level-item level-item-more">
                <span class="level-item-name">+${remainingCount} more</span>
              </div>
            `;
          }

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
                  .content {
                    position: absolute;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    z-index: 2;
                    display: flex;
                    flex-direction: column;
                    padding: ${20*multiplier}px ${18*multiplier}px;
                    box-sizing: border-box;
                  }
                  .header {
                    display: flex;
                    align-items: center;
                    gap: ${16*multiplier}px;
                    margin-bottom: ${10*multiplier}px;
                  }
                  .pack-icon {
                    width: ${iconSize}px;
                    height: ${iconSize}px;
                    border-radius: ${8*multiplier}px;
                    object-fit: cover;
                    flex-shrink: 0;
                  }
                  .pack-icon-placeholder {
                    width: ${iconSize}px;
                    height: ${iconSize}px;
                    border-radius: ${8*multiplier}px;
                    background-color: #2a2a2a;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: ${Math.floor(iconSize * 0.6)}px;
                    flex-shrink: 0;
                  }
                  .pack-info {
                    flex: 1;
                    min-width: 0;
                  }
                  .pack-title {
                    font-weight: 800;
                    font-size: ${40*multiplier}px;
                    color: white;
                    margin: 0 0 ${8*multiplier}px 0;
                    overflow: hidden;
                    display: -webkit-box;
                    -webkit-line-clamp: 2;
                    line-height: 1.2;
                    -webkit-box-orient: vertical;
                  }
                  .pack-owner {
                    display: flex;
                    align-items: center;
                    gap: ${8*multiplier}px;
                    margin: 0;
                  }
                  .pack-owner-avatar {
                    width: ${40*multiplier}px;
                    height: ${40*multiplier}px;
                    border-radius: 50%;
                    object-fit: cover;
                    flex-shrink: 0;
                  }
                  .pack-owner-name {
                    font-weight: 600;
                    font-size: ${32*multiplier}px;
                    color: #bbbbbb;
                  }
                  .levels-section {
                    display: flex;
                    flex-direction: column;
                    gap: ${10*multiplier}px;
                    margin-top: ${8*multiplier}px;
                  }
                  .level-item {
                    display: flex;
                    align-items: center;
                    gap: ${12*multiplier}px;
                    padding: ${6*multiplier}px ${12*multiplier}px;
                    background-color: rgba(255, 255, 255, 0.1);
                    border-radius: ${6*multiplier}px;
                  }
                  .level-item-icon {
                    width: ${32*multiplier}px;
                    height: ${32*multiplier}px;
                    flex-shrink: 0;
                  }
                  .level-item-name {
                    font-weight: 600;
                    font-size: ${32*multiplier}px;
                    color: white;
                    overflow: hidden;
                    display: -webkit-box;
                    -webkit-line-clamp: 1;
                    -webkit-box-orient: vertical;
                  }
                  .level-item-more {
                    background-color: rgba(255, 255, 255, 0.05);
                    justify-content: center;
                  }
                  .level-item-more .level-item-name {
                    font-weight: 700;
                    color: white;
                  }
                </style>
              </head>
              <body>
                <img 
                  class="background-image"
                  src="data:image/png;base64,${backgroundBuffer.toString('base64')}" 
                  alt="Background"
                />
                <div class="content">
                  <div class="header">
                    ${hasIcon && iconBuffer ? `
                      <img 
                        class="pack-icon"
                        src="data:image/png;base64,${iconBuffer!.toString('base64')}" 
                        alt="Pack Icon"
                      />
                    ` : `
                      <div class="pack-icon-placeholder">📦</div>
                    `}
                    <div class="pack-info">
                      <div class="pack-title">${pack.name}</div>
                      <div class="pack-owner">
                        ${ownerAvatarBuffer ? `
                          <img 
                            class="pack-owner-avatar"
                            src="data:image/png;base64,${ownerAvatarBuffer.toString('base64')}" 
                            alt="Owner Avatar"
                          />
                        ` : ''}
                        <span class="pack-owner-name">${(pack as any).packOwner?.username || 'Unknown'}</span>
                      </div>
                    </div>
                  </div>
                  ${levelItems.length > 0 || remainingCount > 0 ? `
                  <div class="levels-section">
                    ${levelsHtml}
                  </div>
                  ` : ''}
                </div>
              </body>
            </html>
          `;

          // Export HTML to file for review
          await exportHtmlToFile(html, 'pack', resolvedPackId);

          const buffer = await htmlToPng(html, width, height);
          await fs.promises.writeFile(largeCachePath, buffer);
          logWithCondition(`Saved LARGE thumbnail for pack ${resolvedPackId} to cache`, 'thumbnail');

          return buffer;
        })();

        thumbnailGenerationPromises.set(promiseKey, generationPromise);

        try {
          largeBuffer = await generationPromise;
        } catch (error) {
          thumbnailGenerationPromises.delete(promiseKey);
          throw error;
        }

        thumbnailGenerationPromises.delete(promiseKey);
      }
    }

    // Validate buffer exists and is valid
    if (!largeBuffer || largeBuffer.length === 0) {
      logger.error(`Invalid or empty buffer for pack ${resolvedPackId}, regenerating...`);
      if (fs.existsSync(largeCachePath)) {
        await fs.promises.unlink(largeCachePath).catch(() => {});
      }
      return res.status(500).send('Error generating image: invalid buffer');
    }

    // Validate PNG signature
    const pngSignature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    if (largeBuffer.length < 8 || !largeBuffer.subarray(0, 8).equals(pngSignature)) {
      logger.error(`Invalid PNG signature for pack ${resolvedPackId}, regenerating...`);
      if (fs.existsSync(largeCachePath)) {
        await fs.promises.unlink(largeCachePath).catch(() => {});
      }
      return res.status(500).send('Error generating image: invalid PNG format');
    }

    if (size === 'LARGE') {
      res.set('Content-Type', 'image/png');
      return res.send(largeBuffer);
    }

    const {width, height} = THUMBNAIL_SIZES[size];
    let resizedBuffer: Buffer;
    try {
      resizedBuffer = await sharp(largeBuffer)
        .resize(width, height, {
          fit: 'contain',
          background: { r: 0, g: 0, b: 0, alpha: 0 }
        })
        .png()
        .toBuffer();
    } catch (sharpError) {
      logger.error(`Sharp error processing buffer for pack ${resolvedPackId}: ${sharpError instanceof Error ? sharpError.message : String(sharpError)}`);
      if (fs.existsSync(largeCachePath)) {
        await fs.promises.unlink(largeCachePath).catch(() => {});
      }
      throw sharpError;
    }

    res.set('Content-Type', 'image/png');
    res.send(resizedBuffer);
    return;
  } catch (error) {
    logger.error(`Error generating image for pack ${req.params.id}:`, error);
    return res.status(500).send('Error generating image');
  }
});

export default router;
