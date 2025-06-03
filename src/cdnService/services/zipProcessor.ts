import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import { CDN_CONFIG } from '../config.js';
import CdnFile from '../../models/cdn/CdnFile.js';
import { logger } from '../../services/LoggerService.js';
import { cleanupFiles } from './storage.js';
import { LevelAnalyzer } from './levelAnalyzer.js';

interface ZipEntry {
    name: string;
    relativePath: string;
    size: number;
    isDirectory: boolean;
}

async function extractZipEntries(zipFilePath: string): Promise<ZipEntry[]> {
    const zip = new AdmZip(zipFilePath);
    const entries = zip.getEntries();
    
    logger.info('Extracting zip entries:', {
        entryCount: entries.length,
        entries: entries.map(entry => ({
            name: entry.name,
            size: entry.header.size,
            isDirectory: entry.isDirectory
        }))
    });

    return entries.map(entry => ({
        name: entry.name,
        relativePath: entry.entryName,
        size: entry.header.size,
        isDirectory: entry.isDirectory
    }));
}

async function extractFile(zipFilePath: string, entry: ZipEntry, targetPath: string): Promise<void> {
    const zip = new AdmZip(zipFilePath);
    const zipEntry = zip.getEntry(entry.relativePath);
    
    if (!zipEntry) {
        throw new Error(`Entry not found in zip: ${entry.relativePath}`);
    }

    // Ensure target directory exists
    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
    
    // Extract the file with proper encoding
    const buffer = zipEntry.getData();
    await fs.promises.writeFile(targetPath, buffer);
    
    logger.debug('Extracted file:', {
        from: entry.relativePath,
        to: targetPath,
        size: entry.size
    });
}

// Helper function to sanitize filename while preserving UTF-8
function sanitizeFilename(filename: string): string {
    // Only remove null bytes and control characters, preserve everything else
    return filename.replace(/[\x00-\x1F\x7F]/g, '');
}

interface LevelFile {
    name: string;
    path: string;
    size: number;
    analysis?: any;
    songFilename?: string;
    hasYouTubeStream?: boolean;
}

interface SongFile extends LevelFile {
    type: string;
}

interface LevelFiles {
    levelFile: LevelFile | null;
    songFile: SongFile | null;
    allLevelFiles: LevelFile[];
}

export async function processZipFile(zipFilePath: string, zipFileId: string ): Promise<void> {
    logger.info('Starting zip file processing:', { zipFilePath, zipFileId });
    
    try {
        const zipEntries = await extractZipEntries(zipFilePath);
        const levelFiles: { [key: string]: any } = {};
        const allLevelFiles: Array<{
            name: string;
            path: string;
            size: number;
            hasYouTubeStream?: boolean;
            songFilename?: string;
        }> = [];
        const songFiles: { [key: string]: any } = {};

        // Create permanent storage directory for this zip
        const permanentDir = path.join(CDN_CONFIG.file_root, 'levels', zipFileId);
        await fs.promises.mkdir(permanentDir, { recursive: true });
        logger.info('Created permanent storage directory:', { permanentDir });

        // Get the original zip filename from the first entry's parent directory
        const firstEntry = zipEntries[0];
        const originalZipName = firstEntry.relativePath.split('/')[0] + '.zip';
        logger.info('Using original zip name from entries:', { originalZipName });

        // Store the original zip file with its original name
        const originalZipPath = path.join(permanentDir, originalZipName);
        await fs.promises.copyFile(zipFilePath, originalZipPath);
        logger.info('Stored original zip file:', { 
            originalZipPath,
            originalZipName
        });

        // First pass: collect all level files
        for (const entry of zipEntries) {
            if (entry.relativePath.endsWith('.adofai')) {
                // Skip backup files
                if (entry.relativePath.toLowerCase().includes('backup')) {
                    continue;
                }

                // Extract to temp first for analysis
                const tempPath = path.join(CDN_CONFIG.temp_root, entry.relativePath);
                await extractFile(zipFilePath, entry, tempPath);

                try {
                    const levelData = await LevelAnalyzer.readLevelFile(tempPath);
                    const analysis = LevelAnalyzer.analyzeLevelData(levelData);
                    
                    // Move file to permanent storage with original filename
                    const levelFilename = path.basename(entry.relativePath);
                    const permanentPath = path.join(permanentDir, levelFilename);
                    await fs.promises.copyFile(tempPath, permanentPath);
                    await fs.promises.unlink(tempPath); // Clean up temp file
                    
                    const levelFile = {
                        name: levelFilename,
                        path: path.join('levels', zipFileId, levelFilename),
                        size: entry.size,
                        hasYouTubeStream: analysis.hasYouTubeStream,
                        songFilename: levelData.settings?.songFilename,
                        artist: levelData.settings?.artist,
                        song: levelData.settings?.song,
                        author: levelData.settings?.author,
                        difficulty: levelData.settings?.difficulty,
                        bpm: levelData.settings?.bpm
                    };

                    levelFiles[entry.relativePath] = levelFile;
                    allLevelFiles.push({
                        name: levelFile.name,
                        path: levelFile.path,
                        size: levelFile.size,
                        hasYouTubeStream: levelFile.hasYouTubeStream,
                        songFilename: levelFile.songFilename
                    });
                } catch (error) {
                    logger.error('Failed to analyze level file:', {
                        error: error instanceof Error ? error.message : String(error),
                        path: entry.relativePath
                    });
                    // Clean up temp file even if analysis fails
                    await fs.promises.unlink(tempPath).catch(() => {});
                }
            }
        }

        if (allLevelFiles.length === 0) {
            throw new Error('No valid level files found in zip');
        }

        // Second pass: extract all song files
        const audioExtensions = ['.mp3', '.ogg', '.wav', '.m4a', '.flac'];
        for (const entry of zipEntries) {
            if (!entry.isDirectory && audioExtensions.includes(path.extname(entry.relativePath).toLowerCase())) {
                // Extract song to temp first
                const songTempPath = path.join(CDN_CONFIG.temp_root, entry.relativePath);
                await extractFile(zipFilePath, entry, songTempPath);

                // Move song to permanent storage with original filename
                const songFilename = path.basename(entry.relativePath);
                const songPermanentPath = path.join(permanentDir, songFilename);
                await fs.promises.copyFile(songTempPath, songPermanentPath);
                await fs.promises.unlink(songTempPath); // Clean up temp file

                songFiles[songFilename] = {
                    name: songFilename,
                    path: path.join('levels', zipFileId, songFilename),
                    size: entry.size,
                    type: path.extname(entry.relativePath).toLowerCase().slice(1)
                };
            }
        }

        // Determine target level
        let targetLevel: string | null = null;
        let pathConfirmed = false;

        if (allLevelFiles.length === 1) {
            // If only one level, automatically set it as target
            targetLevel = allLevelFiles[0].path;
            pathConfirmed = true;
        }

        // Create database entry
        await CdnFile.create({
            id: zipFileId,
            type: 'LEVELZIP',
            filePath: permanentDir,
            metadata: {
                levelFiles,
                allLevelFiles,
                songFiles,
                targetLevel,
                pathConfirmed,
                originalZip: {
                    name: originalZipName,
                    path: path.join('levels', zipFileId, originalZipName),
                    size: (await fs.promises.stat(originalZipPath)).size
                }
            }
        });

        logger.info('Successfully processed zip file:', {
            fileId: zipFileId,
            levelCount: allLevelFiles.length,
            songCount: Object.keys(songFiles).length,
            targetLevel,
            pathConfirmed,
            permanentDir,
            hasOriginalZip: true
        });
    } catch (error) {
        logger.error('Error processing zip file:', {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            zipFilePath,
            zipFileId
        });
        throw error;
    }
}

export async function repackZipFile(zipFileId: string) {
    let tempZipPath: string | null = null;
    
    logger.info('Starting zip file repacking:', { zipFileId });
    
    try {
        const levelEntry = await CdnFile.findByPk(zipFileId);
        if (!levelEntry || !levelEntry.metadata) {
            logger.error('Level entry not found or invalid:', {
                zipFileId,
                hasEntry: !!levelEntry,
                hasMetadata: !!levelEntry?.metadata
            });
            throw new Error('Level entry not found or invalid');
        }

        const { levelFile, songFile } = levelEntry.metadata as {
            levelFile: LevelFile;
            songFile: SongFile;
        };

        if (!levelFile || !songFile) {
            logger.error('Missing level or song file metadata:', {
                hasLevelFile: !!levelFile,
                hasSongFile: !!songFile
            });
            throw new Error('Missing level or song file metadata');
        }

        tempZipPath = path.join(
            CDN_CONFIG.user_root,
            'temp',
            'repacked_' + Date.now() + '_' + Math.random().toString(36).substring(7) + '.zip'
        );
        logger.info('Created temporary zip path:', { tempZipPath });

        const zip = new AdmZip();
        
        // Add level and song files to zip
        logger.info('Adding files to zip:', {
            levelFile: {
                name: levelFile.name,
                path: levelFile.path
            },
            songFile: {
                name: songFile.name,
                path: songFile.path
            }
        });

        zip.addLocalFile(
            path.join(CDN_CONFIG.user_root, levelFile.path),
            '',
            levelFile.name
        );
        zip.addLocalFile(
            path.join(CDN_CONFIG.user_root, songFile.path),
            '',
            songFile.name
        );

        logger.info('Writing zip file to disk:', { tempZipPath });
        zip.writeZip(tempZipPath);
        
        logger.info('Zip file repacked successfully');
        return tempZipPath;
    } catch (error) {
        logger.error('Error repacking zip file:', {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            zipFileId,
            tempZipPath
        });
        
        if (tempZipPath) {
            logger.info('Cleaning up temporary zip file due to error:', { tempZipPath });
            cleanupFiles(tempZipPath);
        }
        throw new Error('Failed to repack zip file');
    }
} 