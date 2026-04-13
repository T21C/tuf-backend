import { Router, Request, Response } from 'express';
import { logger } from '@/server/services/core/LoggerService.js';
import CdnFile from '@/models/cdn/CdnFile.js';
import fs from 'fs';
import path from 'path';
import { transformLevel } from '@/externalServices/cdnService/services/levelTransformer.js';
import { repackZipFile } from '@/externalServices/cdnService/services/zipProcessor.js';
import { spacesStorage } from '@/externalServices/cdnService/services/spacesStorage.js';
import {
    CdnSpacesTempDomain,
    withCdnFileDomainWorkspace
} from '@/externalServices/cdnService/services/cdnSpacesTemp.js';
import LevelDict from 'adofai-lib';
import { AnalysisCacheData, levelCacheService } from '@/externalServices/cdnService/services/levelCacheService.js';
import { Op } from 'sequelize';

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
                hasYouTubeStream: levelFile.hasYouTubeStream,
                oversizedUnparsed: !!levelFile.oversizedUnparsed
            };
        }),
        originalZip: {
            name: metadata.originalZip.name,
            size: metadata.originalZip.size,
            originalFilename: metadata.originalZip.originalFilename
        },
        transformUnavailable: !!metadata.targetLevelOversized
    };
}

const router = Router();

// Transform level endpoint
router.get('/:fileId/transform', async (req: Request, res: Response) => {
    const { fileId } = req.params;
    if (!fileId) {
        throw { error: 'File ID is required', code: 400 };
    }

    try {
        await withCdnFileDomainWorkspace(
            CdnSpacesTempDomain.LevelsRouteRepack,
            fileId,
            async ({ dir, join }) => {
                const uuidRepackDir = dir;
                const tempDir = join('temp');
                await fs.promises.mkdir(tempDir, { recursive: true });

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
                    targetLevelOversized?: boolean;
                    originalZip?: {
                        name: string;
                        path: string;
                        size: number;
                        originalFilename?: string;
                    };
                };

                // Transform (event keep/drop, etc.) is not available for oversized levels that were not parsed
                if (metadata.targetLevelOversized) {
                    throw { error: 'Transform not available for this level (file too large to process). Please download the original zip.', code: 400 };
                }

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
                const levelExists = await spacesStorage.fileExists(metadata.targetLevel);

                if (!levelExists) {
                    logger.error('Target level file not found in any storage:', {
                        fileId,
                        targetLevel: metadata.targetLevel,
                    });
                    throw { error: 'Target level file not found in storage', code: 400 };
                }

                logger.debug('Target level found using fallback logic:', {
                    fileId,
                    targetLevel: metadata.targetLevel,
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

                if (levelExists) {
                    const tempPath = path.join(tempDir, `level_${Date.now()}.adofai`);
                    await spacesStorage.downloadFileToPathStreaming(levelPath, tempPath);
                    parsedLevel = await new LevelDict(tempPath);
                    fs.promises.unlink(tempPath).catch(() => {});
                } else {
                    throw { error: 'Target level file not found in storage', code: 400 };
                }

                // Transform the level
                const transformedLevel = transformLevel(parsedLevel, options);

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

                        const songExists = await spacesStorage.fileExists(selectedSongFile.path);

                        if (!songExists) {
                            logger.error('Song file not found in any storage:', {
                                fileId,
                                songFilename: selectedSongFile.name,
                                songPath: selectedSongFile.path,
                            });
                            throw { error: 'Song file not found in storage', code: 400 };
                        }

                        if (songExists) {
                            const tempSongPath = path.join(tempDir, `song_${Date.now()}_${selectedSongFile.name}`);
                            await spacesStorage.downloadFileToPathStreaming(selectedSongFile.path, tempSongPath);
                            songFilePath = tempSongPath;
                        } else {
                            throw { error: 'Song file not found in storage', code: 400 };
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

                    const fileStream = fs.createReadStream(repackZipPath);

                    await new Promise<void>((resolve, reject) => {
                        let settled = false;
                        const settleResolve = () => {
                            if (settled) return;
                            settled = true;
                            resolve();
                        };
                        const settleReject = (err: unknown) => {
                            if (settled) return;
                            settled = true;
                            reject(err);
                        };

                        fileStream.on('open', () => {
                            fs.promises.unlink(tempLevelPath).catch(() => {});
                            if (songFilePath) {
                                fs.promises.unlink(songFilePath).catch(() => {});
                            }

                            logger.debug('Repack zip created and streaming started:', {
                                fileId,
                                uuidRepackDir,
                                zipPath: repackZipPath,
                                timestamp: new Date().toISOString()
                            });
                        });

                        fileStream.on('error', (error) => {
                            logger.error('Error streaming zip file:', {
                                error: error.message,
                                zipPath: repackZipPath,
                                fileId,
                                uuidRepackDir
                            });

                            if (!res.headersSent) {
                                res.status(500).json({ error: 'Error streaming file' });
                            }

                            settleReject(error);
                        });

                        res.once('finish', () => settleResolve());
                        res.once('close', () => {
                            if (!settled) {
                                settleReject(new Error('Response closed before completion'));
                            }
                        });

                        fileStream.pipe(res);
                    });
                } else if (format === 'adofai') {
                    res.setHeader('Content-Type', 'application/json');

                    const displayFilename = path.basename(levelPath);
                    res.setHeader('Content-Disposition', encodeContentDisposition(`transformed_${displayFilename}`));
                    res.setHeader('Cache-Control', 'no-store');
                    res.json(transformedLevel);
                    return;
                }
                else {
                    res.setHeader('Content-Type', 'application/json');
                    res.setHeader('Cache-Control', 'no-store');
                    res.json(transformedLevel);
                    return;
                }
            }
        );
    } catch (error) {
        logger.error('Unexpected level transformation error for ' + req.params.fileId + ':', error);

        if (res.headersSent) {
            return;
        }

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
                oversizedUnparsed?: boolean;
            }>;
            targetLevel?: string | null;
            targetLevelOversized?: boolean;
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

        // Oversized levels were not parsed; transform (event keep/drop, etc.) is not available
        if (metadata.targetLevelOversized) {
            return res.status(200).json({
                transformUnavailable: true,
                reason: 'oversized',
                eventTypes: [],
                filterTypes: [],
                advancedFilterTypes: []
            });
        }

        const { cacheData } = await levelCacheService.getLevelCache(file, metadata.targetLevel!, metadata);
        return res.json(cacheData.transformOptions || {
            eventTypes: [],
            filterTypes: [],
            advancedFilterTypes: []
        });
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
        targetLevelOversized?: boolean;
    };
    if (!metadata.allLevelFiles || metadata.allLevelFiles.length === 0) {
        throw { error: 'No level files found in metadata', code: 400 };
    }
    if (metadata.targetLevelOversized) {
        throw { error: 'Level data is not available for this file (level too large to parse)', code: 400 };
    }
    const targetLevel = metadata.targetLevel || metadata.allLevelFiles[0].path;
    const levelExists = await spacesStorage.fileExists(
        targetLevel
    );
    if (!levelExists) {
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

    const needsHeavyModes = requestedModes.some(mode =>
        mode === 'actions' ||
        mode === 'decorations' ||
        mode === 'angles' ||
        mode === 'relativeAngles' ||
        mode === 'durations'
    );

    const { cacheData: levelCache, levelData: cacheLevelData } =
        await levelCacheService.getLevelCache(file, targetLevel, metadata);

    if (requestedModes.includes('settings')) {
        response.settings = levelCache.settings;
    }
    if (requestedModes.includes('tilecount')) {
        response.tilecount = levelCache.tilecount;
    }
    if (requestedModes.includes('analysis') && levelCache.analysis) {
        response.analysis = levelCache.analysis;
    }

    let levelData: LevelDict | null = cacheLevelData ?? null;
    if (needsHeavyModes && !levelData) {
        const result = await levelCacheService.loadLevelData(file, targetLevel, metadata);
        levelData = result.levelData;
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
            targetLevelOversized?: boolean;
        };
        const targetLevel = metadata.targetLevel || metadata.allLevelFiles?.[0]?.path;
        if (!targetLevel) {
            throw { error: 'Target level file not found in metadata', code: 400 };
        }
        if (metadata.targetLevelOversized) {
            throw { error: 'Level file is too large to serve as JSON. Please download the original zip.', code: 400 };
        }

        if (metadata.targetSafeToParse) {
            const levelExists = await spacesStorage.fileExists(targetLevel);

            if (!levelExists) {
                throw { error: 'Target level file not found in storage', code: 400 };
            }

            const jsonContent = await withCdnFileDomainWorkspace(
                CdnSpacesTempDomain.LevelsRouteMisc,
                fileId,
                async ({ join }) => {
                    const tempPath = join(`serve_${Date.now()}.adofai`);
                    await spacesStorage.downloadFileToPathStreaming(targetLevel, tempPath);
                    return await fs.promises.readFile(tempPath, 'utf8');
                }
            );

            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Cache-Control', 'no-store');
            res.json(JSON.parse(jsonContent));
            return;
        }

        const levelExists = await spacesStorage.fileExists(targetLevel);

        if (!levelExists) {
            throw { error: 'Target level file not found in storage', code: 400 };
        }

        const levelData = await withCdnFileDomainWorkspace(
            CdnSpacesTempDomain.LevelsRouteMisc,
            fileId,
            async ({ join }) => {
                const tempPath = join(`parse_${Date.now()}.adofai`);
                await spacesStorage.downloadFileToPathStreaming(targetLevel, tempPath);
                return new LevelDict(tempPath);
            }
        );

        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.json(levelData.toJSON());
        return;
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
