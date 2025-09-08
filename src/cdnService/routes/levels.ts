import { Router, Request, Response } from "express";
import { logger } from "../../services/LoggerService.js";
import CdnFile from "../../models/cdn/CdnFile.js";
import { CDN_CONFIG } from "../config.js";
import FileAccessLog from "../../models/cdn/FileAccessLog.js";
import fs from "fs";
import path from "path";
import { PROTECTED_EVENT_TYPES, transformLevel } from "../services/levelTransformer.js";
import { repackZipFile } from "../services/zipProcessor.js";
import { hybridStorageManager, StorageType } from "../services/hybridStorageManager.js";
import LevelDict, { LevelJSON, Action } from "adofai-lib";
import { decodeFilename } from "../misc/utils.js";

// Add helper function for sanitizing filenames
const sanitizeFilename = (filename: string): string => {
  // Remove or replace invalid characters
  return filename
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_') // Replace invalid characters with underscore
    .replace(/\s+/g, '_') // Replace spaces with underscore
    .replace(/^\.+/, '') // Remove leading dots
    .replace(/\.+$/, '') // Remove trailing dots
    .substring(0, 255); // Limit length
};

// Add helper function for encoding Content-Disposition
const encodeContentDisposition = (filename: string): string => {
  const sanitized = sanitizeFilename(filename);
  
  return `attachment; filename*=UTF-8''${sanitized}`;
};

const router = Router();

// Function to extract unique event types and filters from a level file
const extractLevelTypes = (levelData: LevelDict) => {
    const eventTypes = new Set<string>();
    const filterTypes = new Set<string>();
    const advancedFilterTypes = new Set<string>();

    if (levelData.getActions().length > 0) {
        levelData.getActions().forEach((action: Action) => {
            if (PROTECTED_EVENT_TYPES.has(action.eventType || '')) {
                return;
            }

            // Extract event types
            if (action.eventType) {
                eventTypes.add(action.eventType);
            }

            // Extract filter types
            if (action.eventType === 'SetFilter' && action.filter) {
                filterTypes.add(action.filter);
            }
            // Extract advanced filter types
            else if (action.eventType === 'SetFilterAdvanced' && action.filter) {
                advancedFilterTypes.add(action.filter);
            }
        });
    }

    return {
        eventTypes: Array.from(eventTypes).sort(),
        filterTypes: Array.from(filterTypes).sort(),
        advancedFilterTypes: Array.from(advancedFilterTypes).sort()
    };
};

// Transform level endpoint
router.get('/:fileId/transform', async (req: Request, res: Response) => {
    const { fileId } = req.params;
    const tempDir = path.join(CDN_CONFIG.user_root, fileId, 'temp');
    try {
        const file = await CdnFile.findByPk(fileId);

        if (!file) {
            throw { error: 'File not found', code: 404 };
        }

        if (file.type !== 'LEVELZIP') {
            throw { error: 'File is not a level zip', code: 400 };
        }

        const metadata = file.metadata as {
            allLevelFiles?: Array<{
                name: string;
                path: string;
                size: number;
                hasYouTubeStream?: boolean;
                songFilename?: string;
            }>;
            songFiles?: Record<string, {
                name: string;
                path: string;
                size: number;
                type: string;
            }>;
            targetLevel?: string | null;
            storageType?: StorageType;
            levelStorageType?: StorageType;
            songStorageType?: StorageType;
        };

        // Log metadata structure for debugging
        logger.debug('Level metadata structure:', {
            hasMetadata: !!file.metadata,
            metadataKeys: file.metadata ? Object.keys(file.metadata) : [],
            targetLevel: metadata.targetLevel,
            hasSongFiles: !!metadata.songFiles,
            songFileCount: metadata.songFiles ? Object.keys(metadata.songFiles).length : 0,
            hasAllLevelFiles: !!metadata.allLevelFiles,
            levelFileCount: metadata.allLevelFiles?.length || 0
        });

        // Validate metadata structure
        if (!file.metadata) {
            logger.error('Missing metadata object:', { fileId });
            throw { error: 'Level metadata is missing', code: 400 };
        }

        if (!metadata.songFiles) {
            logger.error('Missing song files in metadata:', { 
                fileId,
                metadata: file.metadata 
            });
            throw { error: 'Song files not found in metadata', code: 400 };
        }

        // If targetLevel is missing, find the largest level file
        if (!metadata.targetLevel) {
            if (!metadata.allLevelFiles || metadata.allLevelFiles.length === 0) {
                logger.error('No level files found in metadata:', { 
                    fileId,
                    metadata: file.metadata 
                });
                throw { error: 'No level files found in metadata', code: 400 };
            }

            // Sort by size and pick the largest
            const largestLevel = metadata.allLevelFiles.reduce((largest, current) => {
                return (current.size > largest.size) ? current : largest;
            });

            logger.debug('Selected largest level file as target:', {
                fileId,
                selectedLevel: largestLevel.name,
                size: largestLevel.size,
                path: largestLevel.path
            });

            metadata.targetLevel = largestLevel.path;
        }

        // Validate target level exists using fallback logic
        const preferredStorageType = metadata.levelStorageType || metadata.storageType;
        const levelCheck = await hybridStorageManager.fileExistsWithFallback(
            metadata.targetLevel, 
            preferredStorageType
        );
        
        if (!levelCheck.exists) {
            logger.error('Target level file not found in any storage:', {
                fileId,
                targetLevel: metadata.targetLevel,
                preferredStorageType,
                checkedStorageType: levelCheck.storageType
            });
            throw { error: 'Target level file not found in storage', code: 400 };
        }
        
        logger.debug('Target level found using fallback logic:', {
            fileId,
            targetLevel: metadata.targetLevel,
            foundInStorage: levelCheck.storageType,
            preferredStorage: preferredStorageType
        });

        // Parse query parameters
        const {
            keepEvents,
            dropEvents,
            extraProtectedEvents,
            baseCameraZoom,
            constantBackgroundColor,
            removeForegroundFlash,
            dropFilters,
            format = 'json' // New parameter: 'json' or 'zip'
        } = req.query;

        logger.debug('query params', req.query);
        // Build transform options
        const options = {
            keepEventTypes: keepEvents !== undefined ? new Set(String(keepEvents).split(',')) : undefined,
            dropEventTypes: dropEvents !== undefined ? new Set(String(dropEvents).split(',')) : undefined,
            extraProtectedEventTypes: extraProtectedEvents ? new Set(String(extraProtectedEvents).split(',')) : undefined,
            baseCameraZoom: baseCameraZoom ? parseFloat(String(baseCameraZoom)) : undefined,
            constantBackgroundColor: constantBackgroundColor ? String(constantBackgroundColor) : undefined,
            removeForegroundFlash: removeForegroundFlash === 'true',
            dropFilters: dropFilters ? new Set(String(dropFilters).split(',')) : undefined
        };

        // Read the level file from storage using the found storage type
        const levelPath = metadata.targetLevel;
        let parsedLevel: LevelDict;
        
        if (levelCheck.storageType === StorageType.SPACES) {
            // Download from Spaces to temporary file
            const tempPath = path.join(tempDir, `level_${Date.now()}.adofai`);
            await hybridStorageManager.downloadFile(levelPath, StorageType.SPACES, tempPath);
            parsedLevel = await new LevelDict(tempPath);
            
            // Clean up temp file after parsing
            fs.promises.unlink(tempPath).catch(() => {});
        } else {
            // Read from local storage using the actual path found
            parsedLevel = await new LevelDict(levelCheck.actualPath);
        }

        // Transform the level
        const transformedLevel = transformLevel(parsedLevel, options);

        // Log the transformation
        await FileAccessLog.create({
            fileId: fileId,
            ipAddress: req.ip,
            userAgent: req.get('user-agent') || null,
            action: 'transform'
        });

        await file.increment('accessCount');

        // Handle different response formats
        if (format === 'zip') {
            // Create a temporary file for the transformed level
            await fs.promises.mkdir(tempDir, { recursive: true });
            
            const tempLevelPath = path.join(tempDir, `transformed_${Date.now()}.adofai`);
            await fs.promises.writeFile(tempLevelPath, JSON.stringify(transformedLevel, null, 2));

            // Find the song file referenced in the level
            const songFilename = transformedLevel.getSetting("songFilename");
            const requiresYSMod = transformedLevel.getSetting("requiredMods")?.includes('YouTubeStream');
            if (!requiresYSMod && (!songFilename || !metadata.songFiles[songFilename])) {
                throw { error: 'Song file not found in level', code: 400 };
            }

            // Handle song file download if needed using fallback logic
            let songFilePath: string | undefined;
            if (!requiresYSMod && songFilename && metadata.songFiles[songFilename]) {
                const songFile = metadata.songFiles[songFilename];
                const preferredSongStorageType = metadata.songStorageType || metadata.storageType;
                
                // Use fallback logic to find the song file
                const songCheck = await hybridStorageManager.fileExistsWithFallback(
                    songFile.path, 
                    preferredSongStorageType
                );
                
                if (!songCheck.exists) {
                    logger.error('Song file not found in any storage:', {
                        fileId,
                        songFilename,
                        songPath: songFile.path,
                        preferredStorageType: preferredSongStorageType
                    });
                    throw { error: 'Song file not found in storage', code: 400 };
                }
                
                if (songCheck.storageType === StorageType.SPACES) {
                    // Download song file from Spaces to temporary location
                    const tempSongPath = path.join(tempDir, `song_${Date.now()}_${songFilename}`);
                    await hybridStorageManager.downloadFile(songFile.path, StorageType.SPACES, tempSongPath);
                    songFilePath = tempSongPath;
                } else {
                    // Use the actual path found in local storage
                    songFilePath = songCheck.actualPath;
                }
            }

            // Create a temporary metadata object for repacking
            const tempMetadata = {
                levelFile: {
                    name: path.basename(levelPath),
                    path: tempLevelPath,
                    size: (await fs.promises.stat(tempLevelPath)).size
                },
                songFile: !requiresYSMod && songFilename && metadata.songFiles[songFilename] && songFilePath ? {
                    name: songFilename,
                    path: songFilePath,
                    size: metadata.songFiles[songFilename].size,
                    type: metadata.songFiles[songFilename].type
                } : undefined
            };

            // Repack the zip
            const zipPath = await repackZipFile(tempMetadata);
            
            // Set headers for zip download with encoded filename
            res.setHeader('Content-Type', 'application/zip');
            
            // Use the original filename from the path (no encoding/decoding needed)
            const displayFilename = path.basename(levelPath);
            res.setHeader('Content-Disposition', encodeContentDisposition(`transformed_${displayFilename}.zip`));
            
            // Stream the zip file
            const fileStream = fs.createReadStream(zipPath);
            fileStream.pipe(res);

            // Clean up after streaming
            fileStream.on('end', () => {
                fs.promises.unlink(zipPath).catch(() => {});
                fs.promises.unlink(tempLevelPath).catch(() => {});
                if (songFilePath && songFilePath.includes('temp')) {
                    fs.promises.unlink(songFilePath).catch(() => {});
                }
            });

            fileStream.on('error', (error) => {
                logger.error('Error streaming zip file:', error);
                fs.promises.unlink(zipPath).catch(() => {});
                fs.promises.unlink(tempLevelPath).catch(() => {});
                if (songFilePath && songFilePath.includes('temp')) {
                    fs.promises.unlink(songFilePath).catch(() => {});
                }
                if (!res.headersSent) {
                    res.status(500).json({ error: 'Error streaming file' });
                }
            });
        } else if (format === 'adofai') {
            // Return JSON response with encoded filename
            res.setHeader('Content-Type', 'application/json');
            
            // Use the original filename from the path (no encoding/decoding needed)
            const displayFilename = path.basename(levelPath);
            res.setHeader('Content-Disposition', encodeContentDisposition(`transformed_${displayFilename}`));
            res.setHeader('Cache-Control', 'no-store');
            res.json(transformedLevel);
        }
        else {
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Cache-Control', 'no-store');
            res.json(transformedLevel);
        }
    } catch (error) {
        logger.error('Level transformation error for ' + req.query.fileId + ':', error);
        fs.promises.rmdir(tempDir, { recursive: true }).catch(() => {logger.error('Failed to delete temp directory: ' + tempDir + ", error: " + error)});
        // Handle custom error objects with code
        if (error && typeof error === 'object' && 'code' in error && 'error' in error) {
            const customError = error as { code: number; error: string };
            res.status(customError.code).json({ error: customError.error });
        } else {
            res.status(500).json({ error: 'Level transformation failed' });
        }
    }
    return;
});

router.get('/transform-options', async (req: Request, res: Response) => {
    try {
        const fileId = req.query.fileId as string;
        
        if (!fileId) {
            throw { error: 'File ID is required', code: 400 };
        }

        const file = await CdnFile.findByPk(fileId);
        if (!file) {
            throw { error: 'File not found', code: 404 };
        }

        if (file.type !== 'LEVELZIP') {
            throw { error: 'File is not a level zip', code: 400 };
        }

        const metadata = file.metadata as {
            allLevelFiles?: Array<{
                name: string;
                path: string;
                size: number;
            }>;
            targetLevel?: string | null;
        };

        // If targetLevel is missing, find the largest level file
        if (!metadata.targetLevel) {
            if (!metadata.allLevelFiles || metadata.allLevelFiles.length === 0) {
                logger.error('No level files found in metadata:', { 
                    fileId,
                    metadata: file.metadata 
                });
                return res.status(400).json({ error: 'No level files found in metadata' });
            }

            // Sort by size and pick the largest
            const largestLevel = metadata.allLevelFiles.reduce((largest, current) => {
                return (current.size > largest.size) ? current : largest;
            });

            logger.debug('Selected largest level file as target:', {
                fileId,
                selectedLevel: largestLevel.name,
                size: largestLevel.size,
                path: largestLevel.path
            });

            metadata.targetLevel = largestLevel.path;
        }

        // Read the level file
        const parsedLevel = await new LevelDict(metadata.targetLevel);
        
        // Extract available types from the level
        const availableTypes = extractLevelTypes(parsedLevel);

        res.json(availableTypes);
    } catch (error) {
        logger.error('Error getting transform options for ' + req.query.fileId + ':', error);
        // Handle custom error objects with code
        if (error && typeof error === 'object' && 'code' in error && 'error' in error) {
            const customError = error as { code: number; error: string };
            res.status(customError.code).json({ error: customError.error });
        } else {
            res.status(500).json({ error: 'Failed to get transform options' });
        }
    }
    return
});

export default router;