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

// Helper function to extract Google Drive file ID
function extractGoogleDriveFileUrl(url: string): string {
  const match = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
  return match ? `https://drive.usercontent.google.com/download?id=${match[1]}` : '';
}

// Helper function to check if response is HTML
function isHtmlResponse(content: string): boolean {
  return content.trim().toLowerCase().startsWith('<!doctype html') || 
         content.trim().toLowerCase().startsWith('<html');
}

// Helper function to parse Google Drive form
function parseGoogleDriveForm(html: string): string {
  const formMatch = html.match(/<form[^>]*action="([^"]*)"[^>]*>/);
  const idMatch = html.match(/name="id"\s+value="([^"]*)"/);
  const exportMatch = html.match(/name="export"\s+value="([^"]*)"/);
  const confirmMatch = html.match(/name="confirm"\s+value="([^"]*)"/);
  const uuidMatch = html.match(/name="uuid"\s+value="([^"]*)"/);
  const atMatch = html.match(/name="at"\s+value="([^"]*)"/);

  if (!formMatch || !idMatch) {
    throw new Error('Could not parse Google Drive form');
  }

  const baseUrl = formMatch[1];
  const params = new URLSearchParams();
  params.append('id', idMatch[1]);
  if (exportMatch) params.append('export', exportMatch[1]);
  if (confirmMatch) params.append('confirm', confirmMatch[1]);
  if (uuidMatch) params.append('uuid', uuidMatch[1]);
  if (atMatch) params.append('at', atMatch[1]);

  return `${baseUrl}?${params.toString()}`;
}

// Helper function to download a file
async function downloadFile(url: string, filepath: string): Promise<void> {
  if (!isValidUrl(url)) {
    throw new Error('Invalid URL');
  }

  // Check if it's a Google Drive link
  if (url.includes('drive.google.com')) {
    const initialUrl = extractGoogleDriveFileUrl(url);
    if (initialUrl === '') {
      throw new Error('Empty Google Drive URL');
    }
    
    logger.info(`Initial Google Drive URL: ${initialUrl}`);
    
    // First request to check if we get HTML or direct download
    const response = await axios({
      method: 'GET',
      url: initialUrl,
      responseType: 'text',
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });

    // If we got HTML, parse the form and get the actual download URL
    if (isHtmlResponse(response.data)) {
      logger.info('Received HTML response, parsing Google Drive form...');
      url = parseGoogleDriveForm(response.data);
      logger.info(`Resolved to download URL: ${url}`);
    } else {
      logger.info('Received direct download response');
      url = initialUrl;
    }
  }

  // Now download the actual file
  const fileResponse = await axios({
    method: 'GET',
    url: url,
    responseType: 'stream',
    timeout: 30000,
    maxContentLength: 1000 * 1024 * 1024, // 1GB max
    validateStatus: (status) => status === 200,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    }
  });

  const writer = fs.createWriteStream(filepath);
  fileResponse.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on('finish', () => {
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

// Add debug mode function
async function debugSingleLink(url: string) {
  logger.info('Debug mode: Testing single link');
  logger.info(`URL: ${url}`);
  
  try {
    const tempPath = path.join(tempDir, 'debug_test.zip');
    await downloadFile(url, tempPath);
    logger.info('Download successful!');
    logger.info(`File saved to: ${tempPath}`);
    logger.info('File is a valid zip');
  } catch (error) {
    logger.error('Download failed:', formatError(error));
  } finally {
    // Clean up
    const tempPath = path.join(tempDir, 'debug_test.zip');
    if (fs.existsSync(tempPath)) {
      await fs.promises.unlink(tempPath);
    }
  }
}

async function migrateLevelZips() {
  // Check for debug mode
  const debugUrl = 'https://drive.google.com/file/d/1doan9YKW-Td67bZKd_f-vpq7DH6O-MZ_/view'
  if (debugUrl && process.env.NODE_ENV === 'development') {
    await debugSingleLink(debugUrl);
    return;
  }

  const stats = {
    total: 0,
    successful: 0,
    failed: 0,
    skipped: 0,
    errors: new Map<string, number>()
  };

  try {
    // Get all levels that don't have a CDN-managed download link
    const levels = await Level.findAll({
      where: {
        dlLink: {
          [Op.and]: [
            { [Op.notLike]: `${CDN_CONFIG.baseUrl}%` },
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
        let dlLink = level.dlLink
        // Skip if URL is invalid
        if (!dlLink.startsWith('https://') && !dlLink.startsWith('http://')) {
          dlLink = 'https://' + dlLink;
        }
        if (!isValidUrl(dlLink)) {
          console.log(level);
          logger.error(`Invalid URL for level ${level.id}: ${dlLink}`);
          stats.skipped++;
          continue;
        }

        // Download the file
        const tempPath = path.join(tempDir, `level_${level.id}.zip`);
        await downloadFile(dlLink, tempPath);

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
        logger.info(`Legacy download link: ${dlLink}`);
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