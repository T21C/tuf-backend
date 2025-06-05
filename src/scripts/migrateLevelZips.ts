import { CDN_CONFIG } from '../cdnService/config.js';
import cdnService from '../services/CdnService.js';
import Level from '../models/levels/Level.js';
import { logger } from '../services/LoggerService.js';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Op } from 'sequelize';
import AdmZip from 'adm-zip';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create temp directory if it doesn't exist
const tempDir = path.join(__dirname, '../../temp');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

// Helper function to check if a URL is from our CDN
const isCdnUrl = (url: string): boolean => {
  return url.startsWith(CDN_CONFIG.baseUrl);
};

// Helper function to validate URL
function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

// Helper function to validate zip file
function isValidZipFile(filepath: string): boolean {
  try {
    const zip = new AdmZip(filepath);
    zip.getEntries(); // This will throw if the zip is invalid
    return true;
  } catch (error) {
    return false;
  }
}

// Helper function to encode filename
function encodeFilename(filename: string): string {
  // Convert filename to UTF-8 bytes and then to hex
  return Array.from(new TextEncoder().encode(filename.replace(/[<>:"/\\|?*]/g, '')))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// Helper function to download a file
async function downloadFile(url: string, filepath: string): Promise<void> {
  if (!isValidUrl(url)) {
    throw new Error('Invalid URL');
  }

  const response = await axios({
    method: 'GET',
    url: url,
    responseType: 'stream',
    timeout: 30000, // 30 second timeout
    maxContentLength: 1000 * 1024 * 1024, // 1GB max
    validateStatus: (status) => status === 200 // Only accept 200 status
  });

  const writer = fs.createWriteStream(filepath);
  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on('finish', () => {
      // Validate the downloaded file is a valid zip
      if (!isValidZipFile(filepath)) {
        reject(new Error('Downloaded file is not a valid zip'));
        return;
      }
      resolve();
    });
    writer.on('error', reject);
  });
}

// Helper function to sleep
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Helper function to format error message
function formatError(error: unknown): string {
  if (error && typeof error === 'object') {
    const err = error as any;
    if (err.response) {
      // Axios error with response
      return `HTTP ${err.response.status}: ${err.response.statusText}`;
    } else if (err.code === 'ENOENT') {
      // File system error
      return `File not found: ${err.path}`;
    } else if (err.code === 'ECONNREFUSED') {
      return 'Connection refused';
    } else if (err.code === 'ETIMEDOUT') {
      return 'Connection timed out';
    } else if (err.message) {
      // Other error with message
      return err.message;
    }
  }
  return 'Unknown error';
}

async function migrateLevelZips() {
  const stats = {
    total: 0,
    successful: 0,
    failed: 0,
    skipped: 0,
    errors: new Map<string, number>() // Track error types
  };

  try {
    // Get all levels that don't have a CDN-managed download link
    const levels = await Level.findAll({
      where: {
        dlLink: {
          [Op.and]: [
            { [Op.notLike]: `${CDN_CONFIG.baseUrl}%` },
            { [Op.notLike]: 'https://drive.google.com/%' },
            { [Op.ne]: 'removed' },
            { [Op.ne]: '' }
          ]
        }
      }
    });

    stats.total = levels.length;
    logger.info(`Found ${levels.length} levels to migrate`);

    for (let i = 0; i < levels.length; i++) {
      const level = levels[i];
      try {
        logger.info(`Processing level ${i + 1}/${levels.length}: ${level.id} - ${level.song} - ${level.artist}`);
        const initialLink = level.dlLink
        // Skip if URL is invalid
        if (!initialLink.startsWith('https://') && !initialLink.startsWith('http://')) {
          level.dlLink = 'https://' + initialLink;
        }
        if (!isValidUrl(initialLink)) {
          console.log(level);
          logger.error(`Invalid URL for level ${level.id}: ${initialLink}`);
          stats.skipped++;
          continue;
        }

        // Download the file
        const tempPath = path.join(tempDir, `level_${level.id}.zip`);
        await downloadFile(initialLink, tempPath);

        // Read the file
        const fileBuffer = await fs.promises.readFile(tempPath);

        // Create encoded filename
        const encodedFilename = encodeFilename(`${level.song} - ${level.artist}.zip`);
        logger.info(`Using encoded filename: ${encodedFilename}`);

        // Upload to CDN
        logger.info(`Uploading level ${level.id} to CDN`);
        const uploadResult = await cdnService.uploadLevelZip(fileBuffer, encodedFilename);

        // Get level files
        const levelFiles = await cdnService.getLevelFiles(uploadResult.fileId);

        // Update level with new download link
        await level.update({
          dlLink: `${CDN_CONFIG.baseUrl}/${uploadResult.fileId}`,
          legacyDllink: level.dlLink
        });

        logger.info(`Successfully migrated level ${level.id}`);
        logger.info(`Legacy download link: ${initialLink}`);
        logger.info(`New download link: ${CDN_CONFIG.baseUrl}/${uploadResult.fileId}`);
        logger.info(`Found ${levelFiles.length} files in the zip`);

        // Clean up temp file
        await fs.promises.unlink(tempPath);

        stats.successful++;

      } catch (error: unknown) {
        const errorMessage = formatError(error);
        logger.error(`Failed to migrate level ${level.id}: ${errorMessage}`);
        stats.failed++;
        
        // Track error types
        const err = error as any;
        const errorType = err.response ? `HTTP ${err.response.status}` : err.code || 'Unknown';
        stats.errors.set(errorType, (stats.errors.get(errorType) || 0) + 1);

        // Clean up temp file if it exists
        const tempPath = path.join(tempDir, `level_${level.id}.zip`);
        if (fs.existsSync(tempPath)) {
          await fs.promises.unlink(tempPath);
        }
      }
    }

    // Print summary
    logger.info('Migration completed');
    logger.info('Summary:');
    logger.info(`Total levels: ${stats.total}`);
    logger.info(`Successfully migrated: ${stats.successful}`);
    logger.info(`Failed: ${stats.failed}`);
    logger.info(`Skipped: ${stats.skipped}`);
    
    // Print error breakdown
    if (stats.errors.size > 0) {
      logger.info('Error breakdown:');
      for (const [errorType, count] of stats.errors) {
        logger.info(`- ${errorType}: ${count} occurrences`);
      }
    }

  } catch (error: unknown) {
    logger.error('Migration failed:', formatError(error));
  }
}

// Run the migration
migrateLevelZips().catch(error => {
  logger.error('Migration script failed:', error);
  process.exit(1);
}); 