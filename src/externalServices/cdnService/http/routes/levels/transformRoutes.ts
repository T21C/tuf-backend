import { Router, Request, Response } from 'express';
import { logger } from '@/server/services/core/LoggerService.js';
import CdnFile from '@/models/cdn/CdnFile.js';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { transformLevel } from '@/externalServices/cdnService/services/levelTransformer.js';
import { repackZipFile } from '@/externalServices/cdnService/services/zipProcessor.js';
import { spacesStorage } from '@/externalServices/cdnService/infra/storage/spacesStorage.js';
import { getOriginalArchiveMeta } from '@/externalServices/cdnService/infra/archive/archiveService.js';
import {
    CdnSpacesTempDomain,
    withCdnFileDomainWorkspace
} from '@/externalServices/cdnService/infra/workspaces/cdnSpacesTemp.js';
import { levelCacheService } from '@/externalServices/cdnService/services/levelCacheService.js';
import { LEVEL_SUPPORTED_AUDIO_EXTENSION_SET } from '@/externalServices/cdnService/constants/levelPackAudio.js';
import { encodeContentDisposition, resolveSongFileForTransform } from './shared/routeUtils.js';

const router = Router();

function getMainServerUrl(): string {
  if (process.env.NODE_ENV === 'production') {
    return process.env.PROD_API_URL || 'http://localhost:3000';
  } else if (process.env.NODE_ENV === 'staging') {
    return process.env.STAGING_API_URL || 'http://localhost:3000';
  } else {
    return process.env.DEV_URL || 'http://localhost:3002';
  }
}

async function ingestDownloadEvent(body: { fileId: string; kind: 'levelzip' | 'transform' }): Promise<void> {
  const secret = process.env.DOWNLOAD_INGEST_SECRET;
  if (!secret) {
    logger.debug('DOWNLOAD_INGEST_SECRET not set, skipping download ingest');
    return;
  }
  const mainServerUrl = getMainServerUrl();
  try {
    await axios.post(`${mainServerUrl}/v2/cdn/download-events`, body, {
      headers: { 'X-Download-Ingest-Key': secret },
      timeout: 5000,
    });
  } catch (error) {
    logger.debug('Failed to ingest download event', {
      fileId: body.fileId,
      kind: body.kind,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

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
                    targetLevelRelativePath?: string | null;
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
                    logger.debug('Missing metadata object:', { fileId });
                    throw { error: 'Level metadata is missing', code: 400 };
                }

                if (!metadata.songFiles) {
                    logger.debug('Missing song files in metadata:', {
                        fileId,
                        metadata: file.metadata
                    });
                    throw { error: 'Song files not found in metadata', code: 400 };
                }

                // If targetLevel is missing, find the largest level file
                if (!metadata.targetLevel) {
                    if (!metadata.allLevelFiles || metadata.allLevelFiles.length === 0) {
                        logger.debug('No level files found in metadata:', {
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
                    logger.debug('Target level file not found in any storage:', {
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

                const levelPath = metadata.targetLevel;
                if (!levelExists) {
                    throw { error: 'Target level file not found in storage', code: 400 };
                }

                const { levelData: parsedLevel } = await levelCacheService.loadLevelData(
                    file,
                    levelPath,
                    metadata
                );

                // Transform the level
                const transformedLevel = transformLevel(parsedLevel, options);

                await file.increment('accessCount');
                ingestDownloadEvent({ fileId: file.id, kind: 'transform' }).catch(() => undefined);

                // Handle different response formats
                if (format === 'zip') {
                    // Create a temporary file for the transformed level in the temp dir
                    await fs.promises.mkdir(tempDir, { recursive: true });

                    const tempLevelPath = path.join(tempDir, `transformed_${Date.now()}.adofai`);
                    transformedLevel.writeToFile(tempLevelPath);

                    // Find the song file referenced in the level
                    const songFilename = transformedLevel.getSetting('songFilename');
                    const requiresYSMod = transformedLevel.getSetting('requiredMods')?.includes('YouTubeStream');

                    // Handle song file download if needed using fallback logic
                    let songFilePath: string | undefined;
                    let selectedSongFile: { name: string; path: string; size: number; type: string } | undefined;

                    if (!requiresYSMod) {
                        selectedSongFile = resolveSongFileForTransform(
                            metadata.songFiles,
                            songFilename ?? undefined,
                            metadata.targetLevelRelativePath ?? undefined
                        );

                        if (!selectedSongFile) {
                            // If not found, search for any file with a known level-pack audio extension
                            logger.debug('Song file not found by name, searching for usable audio extensions', {
                                fileId,
                                requestedSongFilename: songFilename,
                                availableSongFiles: Object.keys(metadata.songFiles)
                            });

                            for (const [, songFile] of Object.entries(metadata.songFiles)) {
                                const fileExtension = path.extname(songFile.name).toLowerCase();
                                if (LEVEL_SUPPORTED_AUDIO_EXTENSION_SET.has(fileExtension)) {
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
                                logger.debug('No song file found (neither specified nor audio-extension fallback)', {
                                    fileId,
                                    requestedSongFilename: songFilename,
                                    availableSongFiles: Object.keys(metadata.songFiles)
                                });
                                throw { error: 'Song file not found in level', code: 400 };
                            }
                        }

                        const songExists = await spacesStorage.fileExists(selectedSongFile.path);

                        if (!songExists) {
                            logger.debug('Song file not found in any storage:', {
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

                    // The transformed payload is always a freshly-generated .zip (browser /
                    // game client expectation), but the source archive may have been any
                    // supported format — strip whatever its real extension is, not just .zip.
                    const originalArchiveMeta = getOriginalArchiveMeta(metadata);
                    const sourceName = originalArchiveMeta?.name || metadata.originalZip?.name || 'level';
                    const sourceExt = originalArchiveMeta?.extension || path.extname(sourceName) || '.zip';
                    const displayFilename = sourceName.endsWith(sourceExt)
                        ? sourceName.slice(0, -sourceExt.length)
                        : sourceName;
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
                            if (settled) {
                                return;
                            }
                            if (res.writableEnded) {
                                settleResolve();
                                return;
                            }
                            logger.debug(
                                'Transform zip stream: response closed before completion (often client disconnect)',
                                { fileId, zipPath: repackZipPath }
                            );
                            settleResolve();
                        });

                        fileStream.pipe(res);
                    });
                } else if (format === 'adofai') {
                    res.setHeader('Content-Type', 'application/json');

                    const displayFilename = path.basename(levelPath);
                    res.setHeader('Content-Disposition', encodeContentDisposition(`transformed_${displayFilename}`));
                    res.setHeader('Cache-Control', 'no-store');
                    res.json(transformedLevel.toJSON());
                    return;
                }
                else {
                    res.setHeader('Content-Type', 'application/json');
                    res.setHeader('Cache-Control', 'no-store');
                    res.json(transformedLevel.toJSON());
                    return;
                }
            }
        );
    } catch (error) {
        if (res.headersSent) {
            return;
        }

        const isCustom =
            error && typeof error === 'object' && 'code' in error && 'error' in error;
        if (isCustom) {
            const customError = error as { code: number; error: string };
            logger.debug('Level transform request rejected', {
                fileId: req.params.fileId,
                code: customError.code,
                error: customError.error,
            });
            return res.status(customError.code).json({ error: customError.error });
        }

        const message = error instanceof Error ? error.message : String(error);
        if (message === 'Response closed before completion') {
            logger.debug('Level transform: response closed before completion', {
                fileId: req.params.fileId,
            });
            return;
        }

        logger.error('Unexpected level transformation error for ' + req.params.fileId + ':', error);
        return res.status(500).json({ error: 'Level transformation failed' });
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
                logger.debug('No level files found in metadata:', {
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
export default router;
