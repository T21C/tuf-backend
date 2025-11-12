import express, {Request, Response, Router} from 'express';
import fetch from 'node-fetch';
import axios from 'axios';
import path from 'path';
import fs from 'fs';
import puppeteer from 'puppeteer';
import Level from '../../models/levels/Level.js';
import Difficulty from '../../models/levels/Difficulty.js';
import {getVideoDetails,} from '../../utils/data/videoDetailParser.js';
import User from '../../models/auth/User.js';
import {Buffer} from 'buffer';
import { Op } from 'sequelize';
import { seededShuffle } from '../../utils/server/random.js';
import { logger } from '../../services/LoggerService.js';
import Creator from '../../models/credits/Creator.js';
import { CreatorAlias } from '../../models/credits/CreatorAlias.js';
import Team from '../../models/credits/Team.js';
import { TeamAlias } from '../../models/credits/TeamAlias.js';
import LevelCredit from '../../models/levels/LevelCredit.js';
import sharp from 'sharp';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { formatCredits, getFileIdFromCdnUrl } from '../../utils/Utility.js';
import Curation from '../../models/curations/Curation.js';
import CurationType from '../../models/curations/CurationType.js';
import { port } from '../../config/app.config.js';
import CdnService from '../../services/CdnService.js';
import Rating from '../../models/levels/Rating.js';

const execAsync = promisify(exec);

// Helper function to format axios errors for cleaner logging
function formatAxiosError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const parts = [
      error.message,
      error.code ? `[${error.code}]` : '',
      error.config?.url ? `URL: ${error.config.url}` : '',
      error.response?.status ? `Status: ${error.response.status}` : '',
    ].filter(Boolean);

    return parts.join(' ');
  }
  return error instanceof Error ? error.message : String(error);
}

// Promise map for tracking ongoing thumbnail generation
const thumbnailGenerationPromises = new Map<string, Promise<Buffer>>();

// Define size presets
const THUMBNAIL_SIZES = {
  SMALL: {width: 400, height: 210, multiplier: 0.5}, // 16:9 ratio
  MEDIUM: {width: 800, height: 420, multiplier: 1},
  LARGE: {width: 1200, height: 630, multiplier: 1.5},
} as const;

// Cache directories
const THUMBNAILS_CACHE_DIR = process.env.THUMBNAILS_CACHE_PATH || path.join(process.cwd(), 'cache', 'thumbnails');

// Ensure cache directories exist
[THUMBNAILS_CACHE_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Cache TTL in milliseconds (20 seconds) for development, 12 hours for production
const CACHE_TTL = process.env.NODE_ENV === 'production' ? 48 * 60 * 60 * 1000 : 20 * 1000;

// Cleanup interval in milliseconds (5 minutes)
const CLEANUP_INTERVAL = 5 * 60 * 1000;

function logWithCondition(message: string, source: string): void {
  if (source === 'thumbnail' && 1!==1) {
    logger.debug('[Thumbnail] ' + message);
  } else if (source === 'wheel' && 1!==1) {
    logger.debug('[Wheel] ' + message);
  } else if (source === 'avatar' && 1!==1) {
    logger.debug('[Avatar] ' + message);
  } else if (source === 'github' && 1!==1) {
    logger.debug('[Github] ' + message);
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

// Singleton Puppeteer instance
let browser: puppeteer.Browser | null = null;
let browserRetries = 0;
const MAX_BROWSER_RETRIES = 5;
const MAX_CONCURRENT_PAGES = 5;
let activePages = 0;

// Add browser management lock
let browserCreationLock: Promise<void> | null = null;
let browserCreationLockResolve: (() => void) | null = null;
let lockAcquiredBy: string | null = null;

// Function to acquire browser creation lock
async function acquireBrowserCreationLock(): Promise<void> {
  const caller = new Error().stack?.split('\n')[2]?.trim() || 'unknown';
  if (browserCreationLock) {
    logger.debug(`[Lock] Waiting for browser creation lock to be released. Current holder: ${lockAcquiredBy}`);
    await browserCreationLock;
  }
  browserCreationLock = new Promise(resolve => {
    browserCreationLockResolve = resolve;
    lockAcquiredBy = caller;
    logger.debug(`[Lock] Browser creation lock acquired by: ${lockAcquiredBy}`);
  });
}

// Function to release browser creation lock
function releaseBrowserCreationLock(): void {
  if (browserCreationLockResolve) {
    logger.debug(`[Lock] Browser creation lock released by: ${lockAcquiredBy}`);
    browserCreationLockResolve();
    browserCreationLock = null;
    browserCreationLockResolve = null;
    lockAcquiredBy = null;
  } else {
    //logger.warn('[Lock] Attempted to release browser creation lock that was not held');
  }
}

// Function to kill existing Puppeteer Chrome processes
async function killExistingPuppeteerProcesses(): Promise<void> {
  if (process.platform === 'win32') {
    // Windows implementation
    const { stdout } = await execAsync('wmic process where "name=\'chrome.exe\'" get ExecutablePath,ProcessId /format:csv');

    const lines = stdout.split('\n').filter(line => line.trim());
    const puppeteerProcesses = lines
      .filter(line => line.toLowerCase().includes('puppeteer'))
      .map(line => {
        const match = line.match(/(\d+),/);
        return match ? match[1] : null;
      })
      .filter((pid): pid is string => pid !== null);

    if (puppeteerProcesses.length > 0) {
      for (const pid of puppeteerProcesses) {
        try {
          await execAsync(`taskkill /F /PID ${pid}`);
          logger.info(`Killed Puppeteer Chrome process with PID: ${pid}`);
        } catch (err) {
          logger.warn(`Failed to kill process ${pid}:`, err);
        }
      }
    } else {
      logger.debug('No Puppeteer Chrome processes found');
    }
  } else {
    // Linux/Mac - Using spawn for better process control
    return new Promise((resolve, reject) => {
      const pkill = spawn('pkill', ['-15', 'chrome']);

      pkill.stdout.on('data', (data) => {
        logger.debug('pkill stdout:', data.toString());
      });

      pkill.stderr.on('data', (data) => {
        logger.debug('pkill stderr:', data.toString());
      });

      pkill.on('close', (code) => {
        if (code === 0 || code === 1) { // 0 = success, 1 = no processes found
          //logger.info('Successfully executed pkill command');
          resolve();
        } else {
          logger.warn(`pkill exited with code ${code}`);
          resolve(); // Still resolve as this might be a non-error case
        }
      });

      pkill.on('error', (err) => {
        logger.error('Error executing pkill:', err);
        reject(err);
      });
    });
  }
}

// Function to create a new browser instance
async function createBrowser(): Promise<puppeteer.Browser> {
  await acquireBrowserCreationLock();
  try {
    // Check if browser was already created while we were waiting for the lock
    if (browser && browser.isConnected()) {
      //logger.debug('Browser was already created while waiting for lock, returning existing instance');
      return browser;
    }

    // Kill any existing Puppeteer processes before creating a new one
    await killExistingPuppeteerProcesses();
    logger.debug('Waiting for 1 second before creating new browser instance');
    await new Promise(resolve => setTimeout(resolve, 1000));
    logger.debug(`Creating new browser instance (attempt ${browserRetries + 1}/${MAX_BROWSER_RETRIES})`);

    const newBrowser = await puppeteer.launch({
      headless: true,
      defaultViewport: null,
      args: [
        '--disable-setuid-sandbox',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--single-process',
        '--disable-extensions',
        '--disable-features=site-per-process',
        '--disable-background-networking',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-breakpad',
        '--disable-component-extensions-with-background-pages',
        '--disable-default-apps',
        '--disable-dev-shm-usage',
        '--disable-domain-reliability',
        '--disable-features=AudioServiceOutOfProcess,IsolateOrigins,site-per-process',
        '--disable-hang-monitor',
        '--disable-ipc-flooding-protection',
        '--disable-notifications',
        '--disable-renderer-backgrounding',
        '--disable-setuid-sandbox',
        '--disable-speech-api',
        '--disable-sync',
        '--hide-scrollbars',
        '--ignore-certificate-errors',
        '--metrics-recording-only',
        '--mute-audio',
        '--no-default-browser-check',
        '--no-first-run',
        '--no-pings',
        '--no-sandbox',
        '--no-zygote',
        '--password-store=basic',
        '--use-mock-keychain',
        '--window-size=1920,1080',
        '--js-flags="--max-old-space-size=512"' // Limit V8 heap size
      ],
      timeout: 60000,
    });

    // Reset retry counter after successful launch
    browserRetries = 0;

    // Set up disconnection handler to mark the browser as needing recreation
    newBrowser.on('disconnected', async () => {
      logger.debug('Browser disconnected, will recreate on next request');
      browser = null;
      // Kill any zombie processes
      await killExistingPuppeteerProcesses();
    });

    // Set the browser instance before returning
    browser = newBrowser;
    return newBrowser;
  } catch (error) {
    logger.error(`Failed to create browser: ${error instanceof Error ? error.message : String(error)}`);
    browserRetries++;

    if (browserRetries >= MAX_BROWSER_RETRIES) {
      browserRetries = 0;
      throw new Error(`Failed to create browser after ${MAX_BROWSER_RETRIES} attempts`);
    }

    // Wait before retrying
    await new Promise(resolve => setTimeout(resolve, 1000));
    return createBrowser();
  } finally {
    releaseBrowserCreationLock();
  }
}

// Function to get or create browser instance
async function getBrowser(): Promise<puppeteer.Browser> {
  if (!browser || !browser.isConnected()) {
    if (browser) {
      // Try to close properly before recreating
      try {
        await browser.close();
      } catch (err) {
        logger.warn(`Failed to close existing browser: ${err}`);
      }
      browser = null;
    }
    browser = await createBrowser();
  }
  return browser;
}

// Function to convert HTML to PNG with retry logic
async function htmlToPng(html: string, width: number, height: number, maxRetries = 3): Promise<Buffer> {
  let lastError;
  let page = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Wait if we have too many active pages
      while (activePages >= MAX_CONCURRENT_PAGES) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      logWithCondition(`HTML to PNG conversion attempt ${attempt}/${maxRetries}`, 'thumbnail');
      const browser = await getBrowser();
      activePages++;
      page = await browser.newPage();

      // Set up page error handling
      page.on('error', err => {
        logger.error('Page error:', err);
      });

      // Set up page console logging
      page.on('console', msg => {
        logger.debug('Page console:', msg.text());
      });

      await page.setViewport({ width, height });
      await page.setContent(html, { timeout: 30000 });

      // Force garbage collection if available
      if (global.gc) {
        global.gc();
      }

      const pngBuffer = await page.screenshot({
        type: 'png',
        omitBackground: true,
      });

      return Buffer.from(pngBuffer);
    } catch (error) {
      lastError = error;
      //logger.warn(`HTML to PNG conversion failed (attempt ${attempt}/${maxRetries}): ${error instanceof Error ? error.message : String(error)}`);

      if (error instanceof Error &&
          (error.message.includes('Protocol error') ||
           error.message.includes('Connection closed') ||
           error.message.includes('Target closed'))) {
        browser = null;
      }
    } finally {
      if (page) {
        try {
          await page.close();
        } catch (err) {
          logger.warn(`Failed to close page: ${err}`);
        }
        activePages--;
      }
    }

    // Wait before retrying
    await new Promise(resolve => setTimeout(resolve, attempt * 1000));
  }

  throw lastError || new Error('HTML to PNG conversion failed');
}

// Add this helper function for retrying image downloads
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

// Improve shutdown handlers
async function cleanupBrowser(): Promise<void> {
  await acquireBrowserCreationLock();
  try {
    if (browser) {
      try {
        await browser.close();
      } catch (err) {
        logger.error(`Error closing browser: ${err}`);
      }
      browser = null;
    }
    // Kill any remaining processes
    await killExistingPuppeteerProcesses();
  } finally {
    releaseBrowserCreationLock();
  }
}

// Graceful shutdown handlers
process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM signal');
  await cleanupBrowser();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('Received SIGINT signal');
  await cleanupBrowser();
  process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', async (error) => {
  logger.error('Uncaught exception:', error);
  await cleanupBrowser();
  process.exit(1);
});

// Handle unhandled promise rejections
// eslint-disable-next-line @typescript-eslint/no-unused-vars
process.on('unhandledRejection', async (reason, promise) => {
  logger.error('Unhandled promise rejection:', reason);
  await cleanupBrowser();
  process.exit(1);
});

// Add periodic browser cleanup
setInterval(async () => {
  if (browser && activePages === 0) {
    logger.debug('Performing periodic browser cleanup');
    try {
      await browser.close();
      browser = null;
    } catch (err) {
      logger.warn(`Failed to perform periodic browser cleanup: ${err}`);
    }
  }
}, 5 * 60 * 1000); // Every 5 minutes

const router: Router = express.Router();

router.get('/image-proxy', async (req: Request, res: Response) => {
  const imageUrl = req.query.url;
  const maxAttempts = 5;
  let attempt = 1;

  try {
    if (!imageUrl || typeof imageUrl !== 'string') {
      return res.status(400).send('Invalid image URL');
    }

    while (attempt <= maxAttempts) {
      try {
        const response = await axios.get(imageUrl, {
          responseType: 'arraybuffer',
          timeout: 10000, // 10 second timeout
        });

        const contentType = response.headers['content-type'];
        res.set('Content-Type', contentType);

        return res.send(response.data);
      } catch (error) {
        // Handle 4XX errors - these are client errors and should not be retried
        if (axios.isAxiosError(error) && error.response) {
          const status = error.response.status;
          if (status >= 400 && status < 500) {
            logger.debug(`Client error (${status}) fetching image from ${imageUrl}`);
            return res.status(status).send(`Error fetching image: ${error.message}`);
          }
        }

        // For 5XX errors, network errors, or timeouts, retry
        if (attempt >= maxAttempts) {
          logger.debug(`Error fetching image after ${maxAttempts} attempts for link ${imageUrl}:`, error);
          return res.status(500).send('Error fetching image.');
        }

        logger.debug(`Image proxy attempt #${attempt} failed for ${imageUrl}, retrying...`);
        attempt++;
        // Wait 1 second before retrying
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    // This should never be reached, but satisfy TypeScript
    return res.status(500).send('Error fetching image.');
  } catch (error) {
    logger.error(`Unexpected error in image proxy for link ${imageUrl}:`, error);
    return res.status(500).send('Error fetching image.');
  }
});

router.get('/bilibili', async (req: Request, res: Response) => {
  const bvid = req.query.bvid;
  const apiUrl = `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`;
  const maxAttempts = 5;
  let attempt = 1;

  while (attempt <= maxAttempts) {
    try {
      const response = await fetch(apiUrl);
      const data = await response.json();

      if (!response.ok) {
        return res.status(response.status).json(data);
      }

      return res.json(data);
    } catch (error) {
      if (attempt >= maxAttempts) {
        logger.error(`Error fetching data after ${maxAttempts} attempts for link ${apiUrl}:`, error);
        return res.status(500).json({error: 'Internal Server Error'});
      }
      logger.debug(`Bilibili call attempt #${attempt} failed, retrying...`);
      attempt++;
      // Wait 1 second before retrying
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  return res.status(500).json({error: 'Internal Server Error'});
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
    logger.error('Error serving avatar:', formatAxiosError(error));
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
    logger.error('Error fetching GitHub asset:', formatAxiosError(error));
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

    // Get file stats for cache headers
    const stats = fs.statSync(fullPath);
    const lastModified = stats.mtime.toUTCString();
    const etag = `"${stats.size}-${stats.mtimeMs}"`;

    // Check if client has a cached version
    const ifNoneMatch = req.headers['if-none-match'];
    const ifModifiedSince = req.headers['if-modified-since'];

    if (
      (ifNoneMatch && ifNoneMatch === etag) ||
      (ifModifiedSince && new Date(ifModifiedSince) >= stats.mtime)
    ) {
      return res.status(304).end(); // Not Modified
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

    // Set cache headers
    res.set({
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=86400, stale-while-revalidate=3600',
      'ETag': etag,
      'Last-Modified': lastModified
    });

    return res.sendFile(fullPath);
  } catch (error) {
    logger.error('Error serving cached image:', error);
    return res.status(500).send('Error serving image');
  }
});

router.get('/thumbnail/level/:levelId([0-9]{1,20})', async (req: Request, res: Response) => {
  try {
    const size = (req.query.size as keyof typeof THUMBNAIL_SIZES) || 'MEDIUM';
    const levelId = parseInt(req.params.levelId);
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
          const fileId = level.dlLink ? getFileIdFromCdnUrl(level.dlLink) : undefined;
          const [details, metadata] = await Promise.all([
          level.videoLink ? axios.get(`http://localhost:${port}/v2/media/video-details/${encodeURIComponent(level.videoLink)}`)
          .then(res => res.data) : undefined,
          fileId ? CdnService.getLevelData(fileId, ['settings','angles','accessCount']) : undefined
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

    logWithCondition('Memory usage after generation', 'thumbnail');
    //checkMemoryUsage();
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
    logger.error(`Error generating image for level ${req.params.levelId}:`, error);
    return res.status(500).send('Error generating image');
  }
});

// Enhanced caching with TTL and cleanup
interface CachedVideoDetails {
  data: any;
  timestamp: number;
  expiresAt: number;
}

const VIDEO_CACHE_TTL = 1000 * 60 * 60 * 24; // 24 hours
const VIDEO_CACHE_NULL_TTL = 1000 * 60 * 5; // 5 minutes for failed lookups
const CACHE_CLEANUP_INTERVAL = 1000 * 60 * 30; // Clean up every 30 minutes

const cachedVideoDetails = new Map<string, CachedVideoDetails>();
const cachedVideoDetailsPromise = new Map<string, Promise<any>>();

// Periodic cleanup for expired cache entries
setInterval(() => {
  const now = Date.now();
  let cleanedCount = 0;

  for (const [key, value] of cachedVideoDetails.entries()) {
    if (now > value.expiresAt) {
      cachedVideoDetails.delete(key);
      cleanedCount++;
    }
  }

  if (cleanedCount > 0) {
    logger.debug('Cleaned up expired video detail cache entries:', {
      count: cleanedCount,
      remaining: cachedVideoDetails.size,
      timestamp: new Date().toISOString()
    });
  }
}, CACHE_CLEANUP_INTERVAL);

router.get('/video-details/:videoLink', async (req: Request, res: Response) => {
  try {
    let videoLink: string;
    try {
      videoLink = decodeURIComponent(req.params.videoLink);
    } catch (error) {
      if (error instanceof URIError) {
        logger.debug('Malformed URI in video details request:', {
          rawLink: req.params.videoLink,
          error: error.message
        });
        return res.status(400).json({
          error: 'Malformed video link',
          details: 'The video link contains invalid URI encoding'
        });
      }
      throw error;
    }
    
    if (!videoLink) {
      return res.status(400).json({
        error: 'Video link is required'
      });
    }
    const now = Date.now();

    // Check if we have valid cached data
    const cached = cachedVideoDetails.get(videoLink);
    if (cached && now < cached.expiresAt) {
      logger.debug('Returning cached video details:', {
        videoLink: videoLink.substring(0, 50),
        age: Math.floor((now - cached.timestamp) / 1000) + 's',
        timestamp: new Date().toISOString()
      });
      return res.json(cached.data);
    }

    // Check if there's already a pending request for this URL
    if (cachedVideoDetailsPromise.has(videoLink)) {
      logger.debug('Waiting for existing video details request:', {
        videoLink: videoLink.substring(0, 50),
        timestamp: new Date().toISOString()
      });

      try {
        const result = await cachedVideoDetailsPromise.get(videoLink);
        return res.json(result);
      } catch (error) {
        // If the promise failed, it will be cleaned up, so we'll fall through to retry
        logger.warn('Existing video details request failed:', {
          error: error instanceof Error ? error.message : String(error),
          videoLink: videoLink.substring(0, 50),
          timestamp: new Date().toISOString()
        });
        throw error;
      }
    }

    // Create new request and ensure all concurrent requests wait for it
    const videoDetailsPromise = (async () => {
      try {
        const videoDetails = await getVideoDetails(videoLink);

        const ttl = videoDetails ? VIDEO_CACHE_TTL : VIDEO_CACHE_NULL_TTL;
        const cacheEntry: CachedVideoDetails = {
          data: videoDetails,
          timestamp: now,
          expiresAt: now + ttl
        };

        cachedVideoDetails.set(videoLink, cacheEntry);

        logger.debug('Fetched and cached video details:', {
          videoLink: videoLink.substring(0, 50),
          success: !!videoDetails,
          ttl: Math.floor(ttl / 1000) + 's',
          timestamp: new Date().toISOString()
        });

        return videoDetails;
      } finally {
        // Always clean up the promise cache after resolution (success or failure)
        cachedVideoDetailsPromise.delete(videoLink);
      }
    })();

    // Store the promise so concurrent requests can await it
    cachedVideoDetailsPromise.set(videoLink, videoDetailsPromise);

    // Await and return the result
    const result = await videoDetailsPromise;
    return res.json(result);

  } catch (error) {
    logger.error('Error getting video details:', {
      error: error instanceof Error ? {
        message: error.message,
        stack: error.stack
      } : error,
      videoLink: req.params.videoLink?.substring(0, 50),
      timestamp: new Date().toISOString()
    });

    return res.status(500).json({
      error: 'Failed to fetch video details',
      details: error instanceof Error ? error.message : String(error)
    });
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
    logger.error('Error generating wheel image:', error);
    return res.status(500).send('Error generating wheel image');
  }
});


export default router;
