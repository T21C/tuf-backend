import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import CdnFile from '../../models/cdn/CdnFile.js';
import { logger } from '../../services/LoggerService.js';
import { storageManager } from './storageManager.js';
import { hybridStorageManager } from './hybridStorageManager.js';
import LevelDict from 'adofai-lib';
import sequelize from '../../config/db.js';
import { Transaction } from 'sequelize';
import { safeTransactionRollback } from '../../utils/Utility.js';
import { decodeFilename } from '../misc/utils.js';


interface ZipEntry {
    name: string;
    relativePath: string;
    size: number;
    isDirectory: boolean;
}

async function extractZipEntries(zipFilePath: string): Promise<ZipEntry[]> {
    const zip = new AdmZip(zipFilePath);
    const entries = zip.getEntries();

    logger.debug('Extracting zip entries:', {
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


export async function processZipFile(zipFilePath: string, zipFileId: string, originalFilename: string): Promise<void> {
    let transaction: Transaction | undefined;
    let permanentDir: string | null = null;

    logger.debug('Starting zip file processing:', {
        zipFilePath,
        zipFileId,
        originalFilename,
        fileSize: (await fs.promises.stat(zipFilePath)).size
    });

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

        // Reserve a drive for temporary operations
        const storageRoot = await storageManager.getDrive();
        logger.debug('Processing zip file on drive:', {
            drive: storageRoot,
            fileId: zipFileId,
            totalEntries: zipEntries.length,
            totalSize: zipEntries.reduce((sum, entry) => sum + entry.size, 0)
        });

        // Create temporary storage directory for this zip processing
        permanentDir = path.join(storageRoot, 'temp', zipFileId);
        await fs.promises.mkdir(permanentDir, { recursive: true });
        logger.debug('Created temporary storage directory:', {
            permanentDir,
            drive: storageRoot
        });

        // Use the original filename directly
        const finalZipName = decodeFilename(originalFilename);
        logger.debug('Using original zip name:', {
            finalZipName
        });

        // Store the original zip file with its original name
        const originalZipPath = path.join(permanentDir, finalZipName);
        await fs.promises.copyFile(zipFilePath, originalZipPath);
        const originalZipSize = (await fs.promises.stat(originalZipPath)).size;
        logger.debug('Stored original zip file:', {
            originalZipPath,
            finalZipName,
            size: originalZipSize,
            drive: storageRoot
        });

        // First pass: collect all level files
        let totalLevelSize = 0;
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
                    const levelDict = new LevelDict(tempPath);

                    const levelFilename = path.basename(entry.relativePath);

                    const levelFile = {
                        name: levelFilename,
                        path: tempPath, // Keep temp path for now, will be uploaded later
                        size: entry.size,
                        hasYouTubeStream: levelDict.getSetting('requiredMods')?.includes('YouTubeStream'),
                        songFilename: levelDict.getSetting('songFilename'),
                        artist: levelDict.getSetting('artist'),
                        song: levelDict.getSetting('song'),
                        author: levelDict.getSetting('author'),
                        difficulty: levelDict.getSetting('difficulty'),
                        bpm: levelDict.getSetting('bpm')
                    };

                    levelFiles[entry.relativePath] = levelFile;
                    allLevelFiles.push(levelFile);
                    totalLevelSize += entry.size;

                    logger.debug('Processed level file:', {
                        name: levelFilename,
                        size: entry.size,
                        path: tempPath,
                        hasYouTubeStream: levelFile.hasYouTubeStream
                    });
                } catch (error) {
                    logger.warn('Failed to process level file:', {
                        entry: entry.relativePath,
                        error: error instanceof Error ? error.message : String(error)
                    });
                    await fs.promises.unlink(tempPath); // Clean up temp file
                }
            }
        }

        // Second pass: collect all song files
        let totalSongSize = 0;
        const audioExtensions = ['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac'];
        for (const entry of zipEntries) {
            if (!entry.isDirectory && audioExtensions.includes(path.extname(entry.relativePath).toLowerCase())) {
                // Extract song to temp first
                const songTempPath = path.join(permanentDir, entry.name);
                await extractFile(zipFilePath, entry, songTempPath);

                const songFilename = path.basename(entry.relativePath);

                songFiles[songFilename] = {
                    name: songFilename,
                    path: songTempPath, // Keep temp path for now, will be uploaded later
                    size: entry.size,
                    type: path.extname(entry.relativePath).toLowerCase().slice(1)
                };
                totalSongSize += entry.size;
            }
        }

        // Upload files to hybrid storage (Spaces or local)
        logger.debug('Uploading processed files to hybrid storage', {
            fileId: zipFileId,
            levelCount: allLevelFiles.length,
            songCount: Object.keys(songFiles).length
        });

        // Upload level files
        const levelUploadResult = await hybridStorageManager.uploadLevelFiles(
            allLevelFiles.map(file => ({
                sourcePath: file.path,
                filename: file.name,
                size: file.size
            })),
            zipFileId
        );

        // Update file paths in metadata
        allLevelFiles.forEach((file, index) => {
            const uploadedFile = levelUploadResult.files[index];
            file.path = uploadedFile.path;
        });

        // Upload song files using hybrid storage manager
        const songUploadResult = await hybridStorageManager.uploadSongFiles(
            Object.values(songFiles).map(songFile => ({
                sourcePath: songFile.path,
                filename: songFile.name,
                size: songFile.size,
                type: songFile.type
            })),
            zipFileId
        );

        // Update file paths in metadata
        const updatedSongFiles: { [key: string]: any } = {};
        songUploadResult.files.forEach((uploadedFile, index) => {
            const originalSongFile = Object.values(songFiles)[index];
            updatedSongFiles[uploadedFile.filename] = {
                ...originalSongFile,
                path: uploadedFile.path,
                storageType: songUploadResult.storageType,
                url: uploadedFile.url,
                key: uploadedFile.key
            };
        });

        // Upload original zip file
        const zipUploadResult = await hybridStorageManager.uploadLevelFile(
            originalZipPath,
            zipFileId,
            finalZipName,
            true // is a zip
        );

        // Clean up temporary files
        storageManager.cleanupFiles(permanentDir);

        // Determine target level
        let targetLevel: string | null = null;
        const pathConfirmed = false;

        if (allLevelFiles.length > 0) {
            // Always select the largest level file as target
            const largestLevel = allLevelFiles.reduce((largest, current) => {
                return (current.size > largest.size) ? current : largest;
            });

            targetLevel = largestLevel.path; // Use storage path (Spaces key or local path)

            logger.debug('Selected largest level file as target:', {
                selectedLevel: largestLevel.name,
                size: largestLevel.size,
                path: largestLevel.path,
                totalLevels: allLevelFiles.length,
                storageType: levelUploadResult.storageType
            });
        }

        // Start transaction for database operations
        transaction = await sequelize.transaction();

        // Create database entry with comprehensive storage information
        await CdnFile.create({
            id: zipFileId,
            type: 'LEVELZIP',
            filePath: zipUploadResult.filePath, // Use the actual storage path
            metadata: {
                levelFiles,
                allLevelFiles,
                songFiles: updatedSongFiles,
                targetLevel,
                pathConfirmed,
                // Always include storage type at the root level for easy access
                storageType: levelUploadResult.storageType,
                originalZip: {
                    name: finalZipName,
                    path: zipUploadResult.filePath, // Use the actual storage path
                    size: originalZipSize,
                    storageType: zipUploadResult.storageType,
                    originalFilename: finalZipName
                },
                levelStorageType: levelUploadResult.storageType,
                songStorageType: songUploadResult.storageType,
                // Add timestamp for debugging
                uploadedAt: new Date().toISOString(),
                storageInfo: {
                    primary: levelUploadResult.storageType,
                    levels: levelUploadResult.storageType,
                    songs: songUploadResult.storageType,
                    zip: zipUploadResult.storageType
                }
            }
        }, { transaction });

        // Commit the transaction
        await transaction.commit();

        logger.debug('Successfully processed zip file:', {
            fileId: zipFileId,
            drive: storageRoot,
            levelCount: allLevelFiles.length,
            songCount: Object.keys(updatedSongFiles).length,
            totalLevelSize,
            totalSongSize,
            originalZipSize,
            totalSize: totalLevelSize + totalSongSize + originalZipSize,
            targetLevel,
            pathConfirmed,
            storageType: levelUploadResult.storageType,
            levelStorageType: levelUploadResult.storageType,
            songStorageType: songUploadResult.storageType,
            zipStorageType: zipUploadResult.storageType,
            hasOriginalZip: true
        });
    } catch (error) {
        // Rollback transaction if it exists
        if (transaction) {
            try {
                await safeTransactionRollback(transaction);
            } catch (rollbackError) {
                logger.warn('Transaction rollback failed:', rollbackError);
            }
        }

        // Clean up created files if database operation failed
        if (permanentDir && fs.existsSync(permanentDir)) {
            try {
                storageManager.cleanupFiles(permanentDir);
                logger.debug('Cleaned up permanent directory after failed processing:', {
                    permanentDir,
                    timestamp: new Date().toISOString()
                });
            } catch (cleanupError) {
                logger.error('Failed to clean up permanent directory after failed processing:', {
                    error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
                    permanentDir,
                    timestamp: new Date().toISOString()
                });
            }
        }

        logger.error('Error processing zip file:', {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            zipFilePath,
            zipFileId,
            timestamp: new Date().toISOString()
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
    songFile?: {
        name: string;
        path: string;
        size: number;
        type: string;
    };
}

export async function repackZipFile(metadata: RepackMetadata, outputDir?: string): Promise<string> {
    let tempZipPath: string | null = null;

    logger.debug('Starting zip file repacking:', { metadata, outputDir });

    try {
        // Use provided output directory or default to temp folder
        if (outputDir) {
            // Ensure output directory exists
            await fs.promises.mkdir(outputDir, { recursive: true });
            tempZipPath = path.join(
                outputDir,
                'repacked_' + Date.now() + '_' + Math.random().toString(36).substring(7) + '.zip'
            );
        } else {
            const storageRoot = await storageManager.getDrive();
            tempZipPath = path.join(
                storageRoot,
                'temp',
                'repacked_' + Date.now() + '_' + Math.random().toString(36).substring(7) + '.zip'
            );
        }
            logger.debug('Created temporary zip path:', { tempZipPath });

            const zip = new AdmZip();

            // Add level file to zip
            logger.debug('Adding level file to zip:', {
                levelFile: {
                    name: metadata.levelFile.name,
                    path: metadata.levelFile.path
                }
            });

            // Use absolute path from the metadata
            zip.addLocalFile(metadata.levelFile.path, '', metadata.levelFile.name);

            // Add song file if present
            if (metadata.songFile) {
                logger.debug('Adding song file to zip:', {
                    songFile: {
                        name: metadata.songFile.name,
                        path: metadata.songFile.path
                    }
                });
                zip.addLocalFile(metadata.songFile.path, '', metadata.songFile.name);
            }

            logger.debug('Writing zip file to disk:', { tempZipPath });
            zip.writeZip(tempZipPath);

            logger.debug('Zip file repacked successfully');
            return tempZipPath;
    } catch (error) {
        logger.error('Error repacking zip file:', {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            metadata,
            tempZipPath,
            outputDir
        });

        if (tempZipPath) {
            logger.debug('Cleaning up temporary zip file due to error:', { tempZipPath });
            // Only cleanup if it's in the temp folder, not in the repack folder
            if (!outputDir) {
                storageManager.cleanupFiles(tempZipPath);
            }
        }
        throw new Error('Failed to repack zip file');
    }
}
