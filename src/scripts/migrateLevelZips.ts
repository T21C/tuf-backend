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
import { exec } from 'child_process';
import { promisify } from 'util';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const execAsync = promisify(exec);

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

// Helper function to check if file is RAR
function isRarFile(filepath: string): boolean {
  return filepath.toLowerCase().endsWith('.rar');
}

// Helper function to create ZIP from directory
async function createZipFromDir(dirPath: string, zipPath: string): Promise<void> {
  try {
    const zip = new AdmZip();
    
    // Add all files from directory to zip recursively
    function addFilesToZip(currentPath: string, basePath: string = '') {
      const files = fs.readdirSync(currentPath);
      
      for (const file of files) {
        const filePath = path.join(currentPath, file);
        const stats = fs.statSync(filePath);
        
        if (stats.isDirectory()) {
          // Recursively add files from subdirectories
          addFilesToZip(filePath, path.join(basePath, file));
        } else {
          // Add file to zip with relative path
          const relativePath = path.join(basePath, file);
          zip.addLocalFile(filePath, basePath);
          logger.info(`Adding file to zip: ${relativePath}`);
        }
      }
    }
    
    // Start adding files from the root directory
    addFilesToZip(dirPath);
    
    // Write zip file
    zip.writeZip(zipPath);
    logger.info(`Successfully created ZIP file at ${zipPath}`);
  } catch (error) {
    logger.error('Failed to create ZIP file:', error);
    throw error;
  }
}

// Helper function to extract RAR file
async function extractRar(rarPath: string, extractDir: string): Promise<void> {
  try {
    // Check if unrar is installed
    try {
      await execAsync('unrar');
    } catch {
      throw new Error('unrar command not found. Please install unrar to handle RAR files.');
    }

    // Create extraction directory if it doesn't exist
    if (!fs.existsSync(extractDir)) {
      fs.mkdirSync(extractDir, { recursive: true });
    }

    // Extract RAR file with full paths
    await execAsync(`unrar x "${rarPath}" "${extractDir}" -y`);
    
    // Verify extraction
    const files = fs.readdirSync(extractDir);
    if (files.length === 0) {
      throw new Error('No files were extracted from the RAR archive');
    }
    
    logger.info(`Successfully extracted RAR file to ${extractDir}`);
    logger.info(`Extracted files: ${files.join(', ')}`);
  } catch (error) {
    logger.error('Failed to extract RAR file:', error);
    throw error;
  }
}

// Helper function to check if URL is accessible
async function isUrlAccessible(url: string): Promise<boolean> {
  try {
    const response = await axios({
      method: 'HEAD',
      url: url,
      timeout: 10000,
      validateStatus: (status) => status < 400,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });
    return true;
  } catch (error) {
    logger.warn(`URL not accessible: ${url} - ${formatError(error)}`);
    return false;
  }
}

// Helper function to clean up temporary files
async function cleanupTempFiles(...paths: string[]): Promise<void> {
  for (const path of paths) {
    if (fs.existsSync(path)) {
      try {
        if (fs.statSync(path).isDirectory()) {
          fs.rmSync(path, { recursive: true, force: true });
        } else {
          fs.unlinkSync(path);
        }
        logger.info(`Cleaned up temporary file: ${path}`);
      } catch (error) {
        logger.warn(`Failed to clean up ${path}:`, error);
      }
    }
  }
}

// Helper function to download a file
async function downloadFile(url: string, filepath: string): Promise<{ finalFilepath: string; originalFilename: string }> {
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
    timeout: 120000,
    maxContentLength: 1000 * 1024 * 1024, // 1GB max
    validateStatus: (status) => status === 200,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    }
  });

  // Get content disposition from headers
  const contentDisposition = fileResponse.headers['content-disposition'];
  
  // Extract filename from content-disposition
  let originalFilename = '';
  if (contentDisposition) {
    const filenameMatch = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
    if (filenameMatch && filenameMatch[1]) {
      originalFilename = filenameMatch[1].replace(/['"]/g, '');
      logger.info(`Extracted filename from Content-Disposition: ${originalFilename}`);
    }
  }

  // If no filename in content-disposition, use the original filepath
  if (!originalFilename) {
    originalFilename = path.basename(filepath);
    logger.info(`No filename in Content-Disposition, using: ${originalFilename}`);
  }

  // Get the extension from the original filename
  const fileExtension = path.extname(originalFilename);
  
  // Create a temporary filepath for the downloaded file
  const tempFilepath = path.join(path.dirname(filepath), `temp_${Date.now()}${fileExtension}`);
  logger.info(`Using temporary filepath: ${tempFilepath}`);

  const writer = fs.createWriteStream(tempFilepath);
  fileResponse.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on('finish', async () => {
      try {
        let finalFilepath = tempFilepath;
        
        // Check if the downloaded file is a RAR
        if (isRarFile(tempFilepath)) {
          logger.info('Downloaded file is a RAR archive, converting to ZIP...');
          
          // Create temporary directories
          const extractDir = path.join(tempDir, `extract_${Date.now()}`);
          const zipPath = path.join(path.dirname(filepath), `temp_${Date.now()}.zip`);
          
          try {
            // Extract RAR
            await extractRar(tempFilepath, extractDir);
            
            // Create ZIP
            await createZipFromDir(extractDir, zipPath);
            
            // Update final filepath to the new zip
            finalFilepath = zipPath;
            
            logger.info('Successfully converted RAR to ZIP');
          } finally {
            // Clean up temporary files
            await cleanupTempFiles(extractDir, tempFilepath);
          }
        }
        
        // Ensure the final file has .zip extension
        if (!finalFilepath.toLowerCase().endsWith('.zip')) {
          const newPath = path.join(path.dirname(finalFilepath), `${path.basename(finalFilepath, path.extname(finalFilepath))}.zip`);
          await fs.promises.rename(finalFilepath, newPath);
          finalFilepath = newPath;
          logger.info(`Renamed file to ensure .zip extension: ${finalFilepath}`);
        }
        
        // Validate the final file is a valid zip
        if (!isValidZipFile(finalFilepath)) {
          reject(new Error('Downloaded file is not a valid zip'));
          return;
        }
        
        resolve({ finalFilepath, originalFilename: originalFilename.replace(/.rar$/g, '.zip') });
      } catch (error) {
        reject(error);
      }
    });
    writer.on('error', reject);
  });
}

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
    const { finalFilepath, originalFilename } = await downloadFile(url, tempPath);
    logger.info(`File saved to: ${finalFilepath}`);
    logger.info(`Original filename: ${originalFilename}`);
    logger.info('Download successful!');
    logger.info('encoded filename: ' + encodeFilename(originalFilename));
  } catch (error) {
    logger.error('Download failed:', error);
  } finally {
    // Clean up
    const tempPath = path.join(tempDir, 'debug_test.zip');
    if (fs.existsSync(tempPath)) {
      await fs.promises.unlink(tempPath);
    }
  }
}

// Helper function to create fresh temp directory
async function createFreshTempDir(): Promise<string> {
  const tempDir = path.join(__dirname, '../../temp');
  
  // Clean up entire temp directory
  if (fs.existsSync(tempDir)) {
    try {
      // Remove all contents of temp directory
      const files = fs.readdirSync(tempDir);
      for (const file of files) {
        const filePath = path.join(tempDir, file);
        if (fs.statSync(filePath).isDirectory()) {
          fs.rmSync(filePath, { recursive: true, force: true });
        } else {
          fs.unlinkSync(filePath);
        }
      }
      logger.info('Cleaned up entire temp directory');
    } catch (error) {
      logger.warn('Failed to clean up temp directory:', error);
    }
  } else {
    // Create temp directory if it doesn't exist
    fs.mkdirSync(tempDir, { recursive: true });
    logger.info('Created temp directory');
  }
  
  return tempDir;
}

// Helper function to clean up temp directory
async function cleanupTempDir(tempDir: string): Promise<void> {
  if (fs.existsSync(tempDir)) {
    try {
      // Remove all contents of temp directory
      const files = fs.readdirSync(tempDir);
      for (const file of files) {
        const filePath = path.join(tempDir, file);
        if (fs.statSync(filePath).isDirectory()) {
          fs.rmSync(filePath, { recursive: true, force: true });
        } else {
          fs.unlinkSync(filePath);
        }
      }
      logger.info('Cleaned up entire temp directory');
    } catch (error) {
      logger.warn('Failed to clean up temp directory:', error);
    }
  }
}

// Helper function to process levels in alternating order
function getAlternatingLevels(levels: Level[]): Level[] {
  const result: Level[] = [];
  let start = 0;
  let end = levels.length - 1;
  
  while (start <= end) {
    // Add from start
    result.push(levels[start]);
    start++;
    
    // Add from end if there are more levels
    if (start <= end) {
      result.push(levels[end]);
      end--;
    }
  }
  
  return result;
}

// Helper function to check and migrate levels in a continuous flow
async function processLevelsContinuously(levels: Level[], tempDir: string, batchSize: number = 5): Promise<{ successful: number; failed: number; skipped: number; errors: Map<string, number> }> {
  const stats = {
    successful: 0,
    failed: 0,
    skipped: 0,
    errors: new Map<string, number>()
  };

  // Track migrated levels and their download links
  const migratedLevels = new Map<string, { fileId: string, levelId: number }>(); // Map of download link -> { fileId, levelId }

  // Get alternating order first
  const alternatingLevels = getAlternatingLevels(levels);
  logger.info(`Processing ${alternatingLevels.length} levels in alternating order`);

  // Process levels in a continuous flow
  for (let i = 0; i < alternatingLevels.length; i += batchSize) {
    const batch = alternatingLevels.slice(i, i + batchSize);
    logger.info(`Processing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(alternatingLevels.length/batchSize)}`);

    // Clean temp directory before each batch
    try {
      const files = fs.readdirSync(tempDir);
      for (const file of files) {
        const filePath = path.join(tempDir, file);
        if (fs.statSync(filePath).isDirectory()) {
          fs.rmSync(filePath, { recursive: true, force: true });
        } else {
          fs.unlinkSync(filePath);
        }
      }
      logger.info('Cleaned temp directory before batch processing');
    } catch (error) {
      logger.warn('Failed to clean temp directory:', error);
    }

    // Check URLs in parallel
    const checkPromises = batch.map(async (level) => {
      let dlLink = level.dlLink.trim();
      if (!dlLink.startsWith('https://') && !dlLink.startsWith('http://')) {
        dlLink = 'https://' + dlLink;
      }
      
      if (!isValidUrl(dlLink)) {
        logger.warn(`Invalid URL for level ${level.id}: ${dlLink}`);
        return null;
      }
      
      try {
        const response = await axios({
          method: 'HEAD',
          url: dlLink,
          timeout: 10000,
          validateStatus: (status) => status < 400,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
          }
        });
        return level;
      } catch (error) {
        logger.warn(`URL not accessible for level ${level.id}: ${dlLink} - ${formatError(error)}`);
        return null;
      }
    });

    // Wait for URL checks to complete
    const accessibleLevels = (await Promise.all(checkPromises)).filter((level): level is Level => level !== null);
    stats.skipped += batch.length - accessibleLevels.length;

    // Immediately process accessible levels
    for (const level of accessibleLevels) {
      const tempPath = path.join(tempDir, `level_${level.id}`);
      try {
        logger.info(`Processing level ${level.id} - ${level.song} - ${level.artist}`);
        let dlLink = level.dlLink.trim();
        if (!dlLink.startsWith('https://') && !dlLink.startsWith('http://')) {
          dlLink = 'https://' + dlLink;
        }

        // Check if this is a duplicate download link
        const existingFileId = migratedLevels.get(dlLink);
        if (existingFileId) {
          logger.info(`Found duplicate download link for level ${level.id}, referencing level with fileId ${existingFileId}`);
          
          // Update level with duplicate marker
          await level.update({
            dlLink: `${level.dlLink}#DUPLICATEOF${existingFileId.levelId}`
          });
          
          logger.info(`Skipped duplicate download for level ${level.id}`);
          stats.successful++;
          continue;
        }

        // Download the file
        const { finalFilepath, originalFilename } = await downloadFile(dlLink, tempPath);

        // Read the file
        const fileBuffer = await fs.promises.readFile(finalFilepath);

        // Use the original filename from Content-Disposition for CDN upload
        const encodedFilename = encodeFilename(originalFilename);
        logger.info(`Using encoded filename from Content-Disposition: ${encodedFilename}`);

        // Upload to CDN
        logger.info(`Uploading level ${level.id} to CDN - ${originalFilename}`);
        const uploadResult = await cdnService.uploadLevelZip(fileBuffer, encodedFilename);

        // Store the fileId for future duplicate checks
        migratedLevels.set(dlLink, { fileId: uploadResult.fileId, levelId: level.id });

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

        stats.successful++;

      } catch (error: unknown) {
        const errorMessage = formatError(error);
        logger.error(`Failed to migrate level ${level.id}: ${errorMessage}`);
        stats.failed++;
        
        // Track error types
        const err = error as any;
        const errorType = err.response ? `HTTP ${err.response.status}` : err.code || 'Unknown';
        stats.errors.set(errorType, (stats.errors.get(errorType) || 0) + 1);
      }
    }

    logger.info(`Batch ${Math.floor(i/batchSize) + 1} complete. Success: ${stats.successful}, Failed: ${stats.failed}, Skipped: ${stats.skipped}`);
  }

  return stats;
}

async function migrateLevelZips() {
  // Check for debug mode
  const debugUrl = ''
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

  // Create fresh temp directory for this migration run
  const tempDir = await createFreshTempDir();

  try {
    // Get all levels that don't have a CDN-managed download link
    const levels = await Level.findAll({
      where: {
        dlLink: {
          [Op.and]: [
            { [Op.notLike]: `${CDN_CONFIG.baseUrl}%` },
            { [Op.ne]: 'removed' },
            { [Op.ne]: '' },
            { [Op.notLike]: '%#DUPLICATEOF%' }
          ]
        }
      }
    });

    stats.total = levels.length;
    logger.info(`Found ${levels.length} levels to migrate`);

    // Process levels in a continuous flow
    const migrationStats = await processLevelsContinuously(levels, tempDir, 20);
    stats.successful = migrationStats.successful;
    stats.failed = migrationStats.failed;
    stats.skipped = migrationStats.skipped;
    stats.errors = migrationStats.errors;

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
  } finally {
    // Clean up the entire temp directory
    await cleanupTempDir(tempDir);
  }
}

// Run the migration
migrateLevelZips().catch(error => {
  logger.error('Migration script failed:', error);
  process.exit(1);
}); 