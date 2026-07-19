import path from 'path';
import fs from 'fs';
import { logger } from '@/server/services/core/LoggerService.js';
import { Request, Response, Router } from 'express';
import CdnFile from '@/models/cdn/CdnFile.js';
import crypto from 'crypto';
import LevelDict from 'adofai-lib';
import { getSequelizeForModelGroup } from '@/config/db.js';
import { Transaction } from 'sequelize';
import { safeTransactionRollback } from '@/misc/utils/Utility.js';
import { levelCacheService } from '@/externalServices/cdnService/services/levelCacheService.js';
import { spacesStorage } from '@/externalServices/cdnService/infra/storage/spacesStorage.js';
import {
    CdnSpacesTempDomain,
    withCdnFileDomainWorkspace
} from '@/externalServices/cdnService/infra/workspaces/cdnSpacesTemp.js';
import { matchLevelFileBySelection } from '@/externalServices/cdnService/domain/level/matchLevelFileSelection.js';

const cdnSequelize = getSequelizeForModelGroup('cdn');

const router = Router();

router.get('/:fileId/levels', async (req: Request, res: Response) => {
    const { fileId } = req.params;

    logger.debug('Getting level files for zip:', { fileId });

    try {
        const levelEntry = await CdnFile.findByPk(fileId);
        if (!levelEntry || !levelEntry.metadata) {
            logger.error('Level entry not found or invalid:', {
                fileId,
                hasEntry: !!levelEntry,
                hasMetadata: !!levelEntry?.metadata
            });
            return res.status(404).json({ error: 'Level entry not found' });
        }

        const { allLevelFiles } = levelEntry.metadata as {
            allLevelFiles: Array<{
                name: string;
                relativePath?: string;
                path: string;
                size: number;
                hasYouTubeStream?: boolean;
                songFilename?: string;
                artist?: unknown;
                song?: unknown;
                author?: unknown;
                difficulty?: unknown;
                bpm?: unknown;
                oversizedUnparsed?: boolean;
            }>;
        };

        if (!allLevelFiles || !Array.isArray(allLevelFiles)) {
            logger.error('No level files found in metadata:', { fileId });
            return res.status(404).json({ error: 'No level files found' });
        }

        const levelFiles = await withCdnFileDomainWorkspace(CdnSpacesTempDomain.LevelsRouteMisc, fileId, async ({ join }) => {
            const tempDir = join('temp');
            await fs.promises.mkdir(tempDir, { recursive: true });

            return await Promise.all(allLevelFiles.map(async (file) => {
                const relativePath = (file.relativePath || file.name || '').replace(/\\/g, '/');
                const identity = {
                    name: file.name,
                    relativePath,
                    fullPath: relativePath,
                    storagePath: file.path,
                    size: file.size,
                };

                if (file.oversizedUnparsed) {
                    // Avoid LevelDict / full-string parse for huge `.adofai` files.
                    return {
                        ...identity,
                        hasYouTubeStream: !!file.hasYouTubeStream,
                        songFilename: file.songFilename,
                        artist: file.artist,
                        song: file.song,
                        author: file.author,
                        difficulty: file.difficulty,
                        bpm: file.bpm
                    };
                }

                try {
                    const objectKey = file.path;
                    const exists = await spacesStorage.fileExists(objectKey);
                    if (!exists) {
                        return {
                            ...identity,
                            error: 'Level object not found in storage'
                        };
                    }

                    const tempPath = path.join(tempDir, `levels_${fileId}_${crypto.randomUUID()}.adofai`);
                    await spacesStorage.downloadFileToPathStreaming(objectKey, tempPath);
                    try {
                        // Read-only metadata probe; does not rewrite canonical storage (see levelCacheService).
                        const levelDict = new LevelDict(tempPath);
                        return {
                            ...identity,
                            hasYouTubeStream: levelDict.getSetting('requiredMods')?.includes('YouTubeStream'),
                            songFilename: levelDict.getSetting('songFilename'),
                            artist: levelDict.getSetting('artist'),
                            song: levelDict.getSetting('song'),
                            author: levelDict.getSetting('author'),
                            difficulty: levelDict.getSetting('difficulty'),
                            bpm: levelDict.getSetting('bpm')
                        };
                    } finally {
                        fs.promises.unlink(tempPath).catch(() => undefined);
                    }
                } catch (error) {
                    logger.error('Failed to analyze level file:', {
                        error: error instanceof Error ? error.message : String(error),
                        fileId,
                        objectKey: file.path
                    });
                    return {
                        ...identity,
                        error: 'Failed to analyze level file'
                    };
                }
            }));
        });

        logger.debug('Successfully retrieved level files:', {
            fileId,
            count: levelFiles.length
        });

        res.json({
            success: true,
            fileId,
            levels: levelFiles
        });
    } catch (error) {
        logger.error('Error getting level files:', {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            fileId
        });
        res.status(500).json({ error: 'Failed to get level files' });
    }
    return;
});

router.put('/:fileId/target-level', async (req: Request, res: Response) => {
    const { fileId } = req.params;
    const { targetLevel } = req.body;
    let transaction: Transaction | undefined;

    logger.debug('Setting target level for zip:', { fileId, targetLevel });

    try {
        // Start transaction
        transaction = await cdnSequelize.transaction();

        const levelEntry = await CdnFile.findByPk(fileId, { transaction });
        if (!levelEntry || !levelEntry.metadata) {
            await safeTransactionRollback(transaction);
            logger.error('Level entry not found or invalid:', {
                fileId,
                hasEntry: !!levelEntry,
                hasMetadata: !!levelEntry?.metadata
            });
            return res.status(404).json({ error: 'Level entry not found' });
        }

        const metadata = levelEntry.metadata as {
            allLevelFiles: Array<{
                name: string;
                relativePath?: string;
                path: string;
                size: number;
                hasYouTubeStream?: boolean;
                songFilename?: string;
                oversizedUnparsed?: boolean;
            }>;
            targetLevel: string | null;
            targetLevelRelativePath?: string | null;
            targetLevelOversized?: boolean;
            pathConfirmed: boolean;
        };

        const matchingLevel = matchLevelFileBySelection(metadata.allLevelFiles, String(targetLevel));

        if (!matchingLevel) {
            await safeTransactionRollback(transaction);
            logger.error('Target level not found in zip:', {
                fileId,
                targetLevel,
                availableLevels: metadata.allLevelFiles.map(f => ({
                    path: f.path,
                    relativePath: f.relativePath,
                    name: f.name
                }))
            });
            return res.status(400).json({ error: 'Target level not found in zip' });
        }

        // Update metadata with the actual file path from the zip within transaction
        // Clear cache since target level has changed (refreshed after commit)
        const nextRelative =
            matchingLevel.relativePath
                ? matchingLevel.relativePath.replace(/\\/g, '/')
                : matchingLevel.name.replace(/\\/g, '/');

        await levelEntry.update({
            metadata: {
                ...(levelEntry.metadata as any),
                ...metadata,
                targetLevel: matchingLevel.path,
                targetLevelRelativePath: nextRelative,
                targetLevelOversized: !!matchingLevel.oversizedUnparsed,
                pathConfirmed: true,
                targetSafeToParse: false
            },
            cacheData: null
        }, { transaction });

        // Commit the transaction
        await transaction.commit();

        logger.debug('Successfully set target level:', {
            fileId,
            targetLevel: matchingLevel.path,
            originalTarget: targetLevel,
            timestamp: new Date().toISOString()
        });

        // Rebuild cache for the new target level (single entry point).
        logger.debug('Refreshing cache for new target level:', { fileId });
        try {
            // Reload the file to get the updated metadata
            await levelEntry.reload();
            await levelCacheService.refreshCache(fileId);
            logger.debug('Cache refreshed successfully for new target level:', { fileId });
        } catch (cacheError) {
            // Log error but don't fail the request
            logger.warn('Failed to refresh cache for new target level (non-critical):', {
                fileId,
                error: cacheError instanceof Error ? cacheError.message : String(cacheError)
            });
        }

        res.json({
            success: true,
            fileId,
            targetLevel: matchingLevel.path
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

        logger.error('Error setting target level:', {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            fileId,
            targetLevel,
            timestamp: new Date().toISOString()
        });
        res.status(500).json({ error: 'Failed to set target level' });
    }
    return;
});


export default router;
