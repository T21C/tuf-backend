import { Router, Request, Response } from 'express';
import { logger } from '../../../server/services/LoggerService.js';
import CdnFile from '../../../models/cdn/CdnFile.js';
import { CDN_CONFIG } from '../config.js';
import FileAccessLog from '../../../models/cdn/FileAccessLog.js';
import fs from 'fs';
import path from 'path';
import { PROTECTED_EVENT_TYPES, transformLevel } from '../services/levelTransformer.js';
import { repackZipFile } from '../services/zipProcessor.js';
import { hybridStorageManager, StorageType } from '../services/hybridStorageManager.js';
import LevelDict, { Action } from 'adofai-lib';
import { AnalysisCacheData, levelCacheService } from '../services/levelCacheService.js';
import { Op } from 'sequelize';

// Repack folder configuration
const REPACK_FOLDER = path.join(CDN_CONFIG.user_root, 'repack');
const REPACK_RETENTION_HOURS = 1;

// Ensure repack folder exists and clean it on startup
const initializeRepackFolder = async () => {
    try {
        if (!fs.existsSync(REPACK_FOLDER)) {
            fs.mkdirSync(REPACK_FOLDER, { recursive: true });
            logger.debug('Created repack folder:', REPACK_FOLDER);
        } else {
            // Clean up old files on startup
            await cleanupRepackFolder();
        }
    } catch (error) {
        logger.error('Failed to initialize repack folder:', error);
    }
};

// Clean up files older than retention period
const cleanupRepackFolder = async () => {
    try {
        const files = await fs.promises.readdir(REPACK_FOLDER);
        const cutoffTime = Date.now() - (REPACK_RETENTION_HOURS * 60 * 60 * 1000);
        let cleanedCount = 0;

        for (const file of files) {
            const filePath = path.join(REPACK_FOLDER, file);
            const stats = await fs.promises.stat(filePath);

            if (stats.mtime.getTime() < cutoffTime) {
                await fs.promises.rm(filePath, { recursive: true, force: true });
                cleanedCount++;
                logger.debug(`Cleaned up old repack folder: ${file}`);
            }
        }

        if (cleanedCount > 0) {
            logger.debug(`Cleaned up ${cleanedCount} old repack folders`);
        }
    } catch (error) {
        logger.error('Failed to cleanup repack folder:', error);
    }
};

// Clean up specific UUID repack folder
const cleanupUuidRepackFolder = async (fileId: string) => {
    try {
        const uuidRepackFolder = path.join(REPACK_FOLDER, fileId);
        if (fs.existsSync(uuidRepackFolder)) {
            await fs.promises.rm(uuidRepackFolder, { recursive: true, force: true });
            logger.debug(`Cleaned up UUID repack folder: ${fileId}`);
        }
    } catch (error) {
        logger.error(`Failed to cleanup UUID repack folder ${fileId}:`, error);
    }
};

// Initialize repack folder on module load
await initializeRepackFolder();

// Schedule periodic cleanup every 30 minutes
setInterval(cleanupRepackFolder, 30 * 60 * 1000);

// Add helper function for sanitizing filenames
function sanitizeFilename(filename: string): string {
  // Remove or replace invalid characters
  return filename
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_') // Replace invalid characters with underscore
    .replace(/\s+/g, '_') // Replace spaces with underscore
    .replace(/^\.+/, '') // Remove leading dots
    .replace(/\.+$/, '') // Remove trailing dots
    .substring(0, 255); // Limit length
}

// Add helper function for encoding Content-Disposition
function encodeContentDisposition(filename: string): string {
  const sanitized = sanitizeFilename(filename);
  // Percent-encode the filename for RFC 2231 compliance
  const encoded = encodeURIComponent(sanitized);

  return `attachment; filename*=UTF-8''${encoded}`;
}

function extractLevelMetadata(metadata: any) {
    return {
        songFiles: Object.values(metadata.songFiles).map((songFile: any) => {
            return {
                name: songFile.name,
                size: songFile.size,
                type: songFile.type
            };
        }),
        allLevelFiles: Object.values(metadata.allLevelFiles).map((levelFile: any) => {
            return {
                name: levelFile.name,
                size: levelFile.size,
                songFilename: levelFile.songFilename,
                hasYouTubeStream: levelFile.hasYouTubeStream
            };
        }),
        originalZip: {
            name: metadata.originalZip.name,
            size: metadata.originalZip.size,
            originalFilename: metadata.originalZip.originalFilename
        }
    };
}

const router = Router();

// Function to extract unique event types and filters from a level file
function extractLevelTypes(levelData: LevelDict) {
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
}

// Transform level endpoint
router.get('/:fileId/transform', async (req: Request, res: Response) => {
    const { fileId } = req.params;
    if (!fileId) {
        throw { error: 'File ID is required', code: 400 };
    }

    // Clean up any existing repack folder for this UUID first
    await cleanupUuidRepackFolder(fileId);

    // Use repack folder instead of temp folder for all repack-related files
    const uuidRepackDir = path.join(REPACK_FOLDER, fileId);
    const tempDir = path.join(uuidRepackDir, 'temp');

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
            originalZip?: {
                name: string;
                path: string;
                size: number;
                originalFilename?: string;
            };
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
            ipAddress: req.ip || req.headers['x-forwarded-for'] || null,
            userAgent: req.get('user-agent') || null,
            action: 'transform'
        });

        await file.increment('accessCount');

        // Handle different response formats
        if (format === 'zip') {
            // Create a temporary file for the transformed level in the temp dir
            await fs.promises.mkdir(tempDir, { recursive: true });

            const tempLevelPath = path.join(tempDir, `transformed_${Date.now()}.adofai`);
            await fs.promises.writeFile(tempLevelPath, JSON.stringify(transformedLevel, null, 2));

            // Find the song file referenced in the level
            const songFilename = transformedLevel.getSetting('songFilename');
            const requiresYSMod = transformedLevel.getSetting('requiredMods')?.includes('YouTubeStream');

            // Handle song file download if needed using fallback logic
            let songFilePath: string | undefined;
            let selectedSongFile: { name: string; path: string; size: number; type: string } | undefined;

            if (!requiresYSMod) {
                // First, try to find the song file specified in the level
                if (songFilename && metadata.songFiles[songFilename]) {
                    selectedSongFile = metadata.songFiles[songFilename];
                } else {
                    // If not found, search for any .ogg or .wav file
                    logger.debug('Song file not found by name, searching for .ogg or .wav files', {
                        fileId,
                        requestedSongFilename: songFilename,
                        availableSongFiles: Object.keys(metadata.songFiles)
                    });

                    // Search through all song files for .ogg or .wav extensions
                    const audioExtensions = ['.ogg', '.wav'];
                    // eslint-disable-next-line @typescript-eslint/no-unused-vars
                    for (const [_, songFile] of Object.entries(metadata.songFiles)) {
                        const fileExtension = path.extname(songFile.name).toLowerCase();
                        if (audioExtensions.includes(fileExtension)) {
                            selectedSongFile = songFile;
                            logger.debug('Found fallback song file', {
                                fileId,
                                selectedSongFile: songFile.name,
                                extension: fileExtension
                            });
                            break;
                        }
                    }

                    if (!selectedSongFile) {
                        logger.error('No song file found (neither specified nor .ogg/.wav fallback)', {
                            fileId,
                            requestedSongFilename: songFilename,
                            availableSongFiles: Object.keys(metadata.songFiles)
                        });
                        throw { error: 'Song file not found in level', code: 400 };
                    }
                }

                const preferredSongStorageType = metadata.songStorageType || metadata.storageType;

                // Use fallback logic to find the song file
                const songCheck = await hybridStorageManager.fileExistsWithFallback(
                    selectedSongFile.path,
                    preferredSongStorageType
                );

                if (!songCheck.exists) {
                    logger.error('Song file not found in any storage:', {
                        fileId,
                        songFilename: selectedSongFile.name,
                        songPath: selectedSongFile.path,
                        preferredStorageType: preferredSongStorageType
                    });
                    throw { error: 'Song file not found in storage', code: 400 };
                }

                if (songCheck.storageType === StorageType.SPACES) {
                    // Download song file from Spaces to temporary location
                    const tempSongPath = path.join(tempDir, `song_${Date.now()}_${selectedSongFile.name}`);
                    await hybridStorageManager.downloadFile(selectedSongFile.path, StorageType.SPACES, tempSongPath);
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
                songFile: !requiresYSMod && selectedSongFile && songFilePath ? {
                    name: selectedSongFile.name,
                    path: songFilePath,
                    size: selectedSongFile.size,
                    type: selectedSongFile.type
                } : undefined
            };

            // Repack the zip into the UUID-specific repack folder
            const repackZipPath = await repackZipFile(tempMetadata, uuidRepackDir);

            // Set headers for zip download with encoded filename
            res.setHeader('Content-Type', 'application/zip');

            // Use the original filename from the path (no encoding/decoding needed)
            const displayFilename = metadata.originalZip?.name.replace('.zip', '');
            res.setHeader('Content-Disposition', encodeContentDisposition(`transformed_${displayFilename}.zip`));

            // Stream the zip file from the repack folder
            const fileStream = fs.createReadStream(repackZipPath);
            fileStream.pipe(res);

            // Clean up temp files immediately after streaming starts
            fileStream.on('open', () => {
                // Clean up temp files but keep the entire UUID repack folder for retention period
                fs.promises.unlink(tempLevelPath).catch(() => {});
                if (songFilePath && songFilePath.includes('temp')) {
                    fs.promises.unlink(songFilePath).catch(() => {});
                }

                logger.debug('Repack zip created and streaming started:', {
                    fileId,
                    uuidRepackDir,
                    zipPath: repackZipPath,
                    retentionHours: REPACK_RETENTION_HOURS,
                    timestamp: new Date().toISOString()
                });
            });

            // Handle streaming errors
            fileStream.on('error', (error) => {
                logger.error('Error streaming zip file:', {
                    error: error.message,
                    zipPath: repackZipPath,
                    fileId,
                    uuidRepackDir
                });

                // Clean up entire UUID repack folder on error
                fs.promises.rm(uuidRepackDir, { recursive: true, force: true }).catch(() => {});

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
        logger.error('Unexpected level transformation error for ' + req.params.fileId + ':', error);

        // Clean up entire UUID repack directory on error
        fs.promises.rm(uuidRepackDir, { recursive: true, force: true }).catch((cleanupError) => {
            logger.error('Failed to delete UUID repack directory:', {
                uuidRepackDir,
                originalError: error,
                cleanupError
            });
        });

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
        // Handle custom error objects with code
        if (error && typeof error === 'object' && 'code' in error && 'error' in error) {
            const customError = error as { code: number; error: string };
            return res.status(customError.code).json({ error: customError.error });
        } else {
        logger.error('Unexpected error getting transform options for ' + req.query.fileId + ':', error);
        return res.status(500).json({ error: 'Unexpected error getting transform options' });
    }
    }
    return
});

router.post('/bulk-metadata', async (req: Request, res: Response) => {
    try {
        const fileIds = req.body.fileIds as string[];
        if (!fileIds || fileIds.length === 0) {
            logger.error('No file IDs provided', fileIds);
            throw { error: 'File IDs are required', code: 400 };
        }
        const files = await CdnFile.findAll({ where: { id: fileIds, metadata: { [Op.not]: null } } });
        const levels = fileIds.map(fileId => {
            const metadata = files.find(file => file.id === fileId)?.metadata as any
            if (!metadata) {
                return null;
            }
            return {
                fileId: fileId,
                metadata: extractLevelMetadata(metadata)
            };

        });

        return res.json(levels);
    } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && 'error' in error) {
            const customError = error as { code: number; error: string };
            return res.status(customError.code).json({ error: customError.error });
        }
        logger.error('Unexpected error getting bulk metadata for ' + req.body.fileIds + ':', error);
        return res.status(500).json({ error: 'Unexpected error getting bulk metadata' });
    }
});

router.get('/:fileId/levelData', async (req: Request, res: Response) => {
    try {
    const { fileId } = req.params;
    const { modes } = req.query;
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
        targetSafeToParse?: boolean;
    };
    if (!metadata.allLevelFiles || metadata.allLevelFiles.length === 0) {
        throw { error: 'No level files found in metadata', code: 400 };
    }
    const targetLevel = metadata.targetLevel || metadata.allLevelFiles[0].path;
    if (!fs.existsSync(targetLevel)) {
        throw { error: 'Target level file not found', code: 400 };
    }

    let response: {
        settings?: any;
        actions?: any;
        decorations?: any;
        angles?: any;
        relativeAngles?: any;
        accessCount?: number;
        tilecount?: number;
        analysis?: AnalysisCacheData;
        durations?: number[];
    } = {};

    // If no modes specified, return full level data (no caching for this case)
    if (!modes || typeof modes !== 'string') {
        const { levelData } = await levelCacheService.loadLevelData(file, targetLevel, metadata);
        return res.json(levelData);
    }

    // Parse requested modes
    const requestedModes = modes.split(',').map((m: string) => m.trim());

    // Check cache hits using cache service (parseCacheData handles version validation)
    const cacheData = levelCacheService.parseCacheData(file.cacheData, metadata);
    const cacheHits = levelCacheService.checkCacheHits(cacheData, requestedModes);
    // Determine if we need to load the level file
    // Analysis requires the level file if not cached, but we can compute it during cache population
    const needsLevelFile = requestedModes.some(mode =>
        (mode === 'actions' || mode === 'decorations' || mode === 'angles' || mode === 'relativeAngles' || mode === 'durations') ||
        (mode === 'settings' && !cacheHits.settings) ||
        (mode === 'tilecount' && !cacheHits.tilecount) ||
        (mode === 'analysis' && !cacheHits.analysis)
    );

    let levelData: LevelDict | null = null;

    if (needsLevelFile) {
        // Determine if we need non-cached data that requires level file loading
        const needsNonCachedData = requestedModes.some(mode =>
            mode === 'actions' || mode === 'decorations' || mode === 'angles' || mode === 'relativeAngles' || mode === 'durations'
        );

        // If we need analysis but don't have it cached, we need to load the level file for cache population
        const needsAnalysisAndNotCached = requestedModes.includes('analysis') && !cacheHits.analysis;

        // Load level file if needed for non-cached data or analysis
        if (needsNonCachedData || needsAnalysisAndNotCached) {
            const result = await levelCacheService.loadLevelData(file, targetLevel, metadata);
            levelData = result.levelData;
        }

        // Get cache with automatic population if needed (pass levelData to avoid re-parsing)
        const { cacheData: updatedCache } = await levelCacheService.getCacheWithPopulation(
            file,
            targetLevel,
            requestedModes,
            metadata,
            levelData || undefined
        );

        // Build response using updated cache
        if (requestedModes.includes('settings')) {
            response.settings = updatedCache.settings;
        }
        if (requestedModes.includes('tilecount')) {
            response.tilecount = updatedCache.tilecount;
        }
        if (requestedModes.includes('analysis') && updatedCache.analysis) {
            response.analysis = updatedCache.analysis;
        }
    } else {
        // All requested data is in cache, use cached values
        const cachedResponse = levelCacheService.getCachedDataForModes(file, requestedModes, metadata);
        response = { ...response, ...cachedResponse };
    }

    // Add non-cached data from levelData if needed
    if (levelData) {
        if (requestedModes.includes('actions')) {
            response.actions = levelData.getActions();
        }
        if (requestedModes.includes('decorations')) {
            response.decorations = levelData.getDecorations();
        }
        if (requestedModes.includes('angles')) {
            response.angles = levelData.getAngles();
        }
        if (requestedModes.includes('relativeAngles')) {
            response.relativeAngles = levelData.getAnglesRelative();
        }
        // Durations are always extracted on-demand from levelData (not cached)
        if (requestedModes.includes('durations')) {
            const durations = levelData.getDurations();
            response.durations = durations.filter((d): d is number => d !== undefined);
        }
    }

    // accessCount is always available from file record
    if (requestedModes.includes('accessCount')) {
        response.accessCount = file.accessCount || 0;
    }

    return res.json(response);
    } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && 'error' in error) {
            const customError = error as { code: number; error: string };
            return res.status(customError.code).json({ error: customError.error });
        }
        logger.error('Unexpected error getting level data for ' + req.params.fileId + ':', error);
        return res.status(500).json({ error: 'Unexpected error getting level data' });
    }
});

router.get('/:fileId/level.adofai', async (req: Request, res: Response) => {
    try {
        const { fileId } = req.params;
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
            targetSafeToParse?: boolean;
            levelStorageType?: StorageType;
            storageType?: StorageType;
        };
        const targetLevel = metadata.targetLevel || metadata.allLevelFiles?.[0]?.path;
        if (!targetLevel) {
            throw { error: 'Target level file not found in metadata', code: 400 };
        }

        // Check if target level is safe to parse (already processed through levelDict)
        if (metadata.targetSafeToParse) {
            // File has already been parsed and written back as valid JSON
            // Stream it directly without re-parsing
            const preferredStorageType = metadata.levelStorageType || metadata.storageType;
            const levelCheck = await hybridStorageManager.fileExistsWithFallback(
                targetLevel,
                preferredStorageType
            );

            if (!levelCheck.exists) {
                throw { error: 'Target level file not found in storage', code: 400 };
            }

            let jsonContent: string;
            if (levelCheck.storageType === StorageType.SPACES) {
                // Download from Spaces and read as text
                const tempPath = path.join(REPACK_FOLDER, fileId, `temp_level_${Date.now()}.adofai`);
                await fs.promises.mkdir(path.dirname(tempPath), { recursive: true });
                await hybridStorageManager.downloadFile(targetLevel, StorageType.SPACES, tempPath);
                jsonContent = await fs.promises.readFile(tempPath, 'utf8');
                // Clean up temp file
                await fs.promises.unlink(tempPath).catch(() => {});
            } else {
                // Read directly from local storage
                jsonContent = await fs.promises.readFile(levelCheck.actualPath, 'utf8');
            }

            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Cache-Control', 'no-store');
            res.json(JSON.parse(jsonContent));
            return;
        } else {
            // Not safe to parse - need to parse through LevelDict
            const preferredStorageType = metadata.levelStorageType || metadata.storageType;
            const levelCheck = await hybridStorageManager.fileExistsWithFallback(
                targetLevel,
                preferredStorageType
            );

            if (!levelCheck.exists) {
                throw { error: 'Target level file not found in storage', code: 400 };
            }

            let levelData: LevelDict;
            if (levelCheck.storageType === StorageType.SPACES) {
                // Download from Spaces to temporary file
                const tempPath = path.join(REPACK_FOLDER, fileId, `temp_level_${Date.now()}.adofai`);
                await fs.promises.mkdir(path.dirname(tempPath), { recursive: true });
                await hybridStorageManager.downloadFile(targetLevel, StorageType.SPACES, tempPath);
                levelData = await new LevelDict(tempPath);
                // Clean up temp file
                await fs.promises.unlink(tempPath).catch(() => {});
            } else {
                // Read from local storage using the actual path found
                levelData = await new LevelDict(levelCheck.actualPath);
            }

            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Cache-Control', 'no-store');
            res.json(levelData.toJSON());
            return;
        }
    } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && 'error' in error) {
            const customError = error as { code: number; error: string };
            return res.status(customError.code).json({ error: customError.error });
        }
        logger.error('Unexpected error getting level.adofai for ' + req.params.fileId + ':', error);
        return res.status(500).json({ error: 'Unexpected error getting level.adofai' });
    }
});
// Get durations from an existing CDN file
router.get('/:fileId/durations', async (req: Request, res: Response) => {
    try {
        const { fileId } = req.params;

        const durations = await levelCacheService.getDurationsFromCdnFile(fileId);

        if (durations === null) {
            return res.status(404).json({ error: 'File not found or could not extract durations' });
        }

        return res.json({ durations });
    } catch (error) {
        logger.error('Error getting durations from CDN file:', error);
        return res.status(500).json({
            error: 'Failed to get durations',
            details: error instanceof Error ? error.message : String(error)
        });
    }
});

export default router;
