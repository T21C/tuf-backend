import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import { CDN_CONFIG } from '../config.js';
import CdnFile from '../../models/cdn/CdnFile.js';
import { logger } from '../../services/LoggerService.js';
import { storageManager } from './storageManager.js';
import { LevelService } from './levelService.js';

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

function decodeFilename(hex: string): string {
    try {
        // Convert hex string to bytes
        const bytes = new Uint8Array(hex.match(/.{1,2}/g)?.map(byte => parseInt(byte, 16)) || []);
        // Convert bytes to UTF-8 string
        return new TextDecoder().decode(bytes);
    } catch (error) {
        logger.error('Failed to decode filename:', {
            error: error instanceof Error ? error.message : String(error),
            encodedString: hex
        });
        return 'level.zip'; // Fallback name
    }
}

export async function processZipFile(zipFilePath: string, zipFileId: string, encodedFilename: string): Promise<void> {
    logger.info('Starting zip file processing:', { zipFilePath, zipFileId, encodedFilename });
    
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

        // Reserve a drive for all operations
        const storageRoot = await storageManager.reserveDrive();
        
        try {
            // Create permanent storage directory for this zip
            const permanentDir = path.join(storageRoot, 'levels', zipFileId);
            await fs.promises.mkdir(permanentDir, { recursive: true });
            logger.info('Created permanent storage directory:', { permanentDir });

            // Decode the filename from the encoded filename
            const finalZipName = decodeFilename(encodedFilename);
            logger.info('Using decoded zip name:', { 
                finalZipName,
                encodedName: encodedFilename,
                decodedSuccessfully: finalZipName !== 'level.zip'
            });

            // Store the original zip file with its decoded name
            const originalZipPath = path.join(permanentDir, finalZipName);
            await fs.promises.copyFile(zipFilePath, originalZipPath);
            logger.info('Stored original zip file:', { 
                originalZipPath,
                finalZipName
            });

            // First pass: collect all level files
            for (const entry of zipEntries) {
                if (entry.relativePath.endsWith('.adofai')) {
                    // Skip backup files
                    if (entry.relativePath.toLowerCase().includes('backup')) {
                        continue;
                    }

                    // Extract to temp first for analysis
                    const tempPath = path.join(storageRoot, 'temp', entry.relativePath);
                    await extractFile(zipFilePath, entry, tempPath);

                    try {
                        const levelData = await LevelService.readLevelFile(tempPath);
                        const analysis = LevelService.analyzeLevelData(levelData);
                        
                        // Move file to permanent storage with original filename
                        const levelFilename = path.basename(entry.relativePath);
                        const permanentPath = path.join(permanentDir, levelFilename);
                        await fs.promises.copyFile(tempPath, permanentPath);
                        await fs.promises.unlink(tempPath); // Clean up temp file
                        
                        const levelFile = {
                            name: levelFilename,
                            path: permanentPath, // Store absolute path
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
                            path: levelFile.path, // Store absolute path
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
                    const songTempPath = path.join(storageRoot, 'temp', entry.name);
                    await extractFile(zipFilePath, entry, songTempPath);

                    // Move song to permanent storage with original filename
                    const songFilename = path.basename(entry.relativePath);
                    const songPermanentPath = path.join(permanentDir, songFilename);
                    await fs.promises.copyFile(songTempPath, songPermanentPath);
                    await fs.promises.unlink(songTempPath); // Clean up temp file

                    songFiles[songFilename] = {
                        name: songFilename,
                        path: songPermanentPath, // Store absolute path
                        size: entry.size,
                        type: path.extname(entry.relativePath).toLowerCase().slice(1)
                    };
                }
            }

            // Clean up the parent temp directory
            const tempDir = path.join(storageRoot, 'temp');
            storageManager.cleanupFiles(tempDir);

            // Determine target level
            let targetLevel: string | null = null;
            let pathConfirmed = false;

            if (allLevelFiles.length > 0) {
                // Always select the largest level file as target
                const largestLevel = allLevelFiles.reduce((largest, current) => {
                    return (current.size > largest.size) ? current : largest;
                });

                targetLevel = largestLevel.path; // Use absolute path

                logger.info('Selected largest level file as target:', {
                    selectedLevel: largestLevel.name,
                    size: largestLevel.size,
                    path: largestLevel.path,
                    totalLevels: allLevelFiles.length
                });
            }

            // Create database entry with absolute path
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
                        name: finalZipName,
                        path: originalZipPath, // Store absolute path
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
        } finally {
            // Always release the drive reservation
            storageManager.releaseDrive();
        }
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

interface RepackMetadata {
    levelFile: {
        name: string;
        path: string;
        size: number;
    };
    songFile: {
        name: string;
        path: string;
        size: number;
        type: string;
    };
}

export async function repackZipFile(metadata: RepackMetadata): Promise<string> {
    let tempZipPath: string | null = null;
    
    logger.info('Starting zip file repacking:', { metadata });
    
    try {
        // Reserve a drive for all operations
        const storageRoot = await storageManager.reserveDrive();
        
        try {
            tempZipPath = path.join(
                storageRoot,
                'temp',
                'repacked_' + Date.now() + '_' + Math.random().toString(36).substring(7) + '.zip'
            );
            logger.info('Created temporary zip path:', { tempZipPath });

            const zip = new AdmZip();
            
            // Add level and song files to zip
            logger.info('Adding files to zip:', {
                levelFile: {
                    name: metadata.levelFile.name,
                    path: metadata.levelFile.path
                },
                songFile: {
                    name: metadata.songFile.name,
                    path: metadata.songFile.path
                }
            });

            // Use absolute paths from the metadata
            zip.addLocalFile(metadata.levelFile.path, '', metadata.levelFile.name);
            zip.addLocalFile(metadata.songFile.path, '', metadata.songFile.name);

            logger.info('Writing zip file to disk:', { tempZipPath });
            zip.writeZip(tempZipPath);
            
            logger.info('Zip file repacked successfully');
            return tempZipPath;
        } finally {
            // Always release the drive reservation
            storageManager.releaseDrive();
        }
    } catch (error) {
        logger.error('Error repacking zip file:', {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            metadata,
            tempZipPath
        });
        
        if (tempZipPath) {
            logger.info('Cleaning up temporary zip file due to error:', { tempZipPath });
            storageManager.cleanupFiles(tempZipPath);
        }
        throw new Error('Failed to repack zip file');
    }
} 