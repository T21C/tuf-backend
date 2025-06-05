import path from "path";
import { logger } from "../../services/LoggerService.js";
import { storageManager } from "../services/storageManager.js";
import { CDN_CONFIG } from "../config.js";
import { processZipFile } from "../services/zipProcessor.js";
import { Request, Response, Router } from 'express';
import CdnFile from "../../models/cdn/CdnFile.js";
import { LevelService } from "../services/levelService.js";
import crypto from 'crypto';

const router = Router();

// Get level files in a zip
router.get('/:fileId/levels', async (req: Request, res: Response) => {
    const { fileId } = req.params;
    
    logger.info('Getting level files for zip:', { fileId });
    
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
                path: string;
                size: number;
                hasYouTubeStream?: boolean;
                songFilename?: string;
            }>;
        };

        if (!allLevelFiles || !Array.isArray(allLevelFiles)) {
            logger.error('No level files found in metadata:', { fileId });
            return res.status(404).json({ error: 'No level files found' });
        }

        // Get fresh analysis for each level file
        const levelFiles = await Promise.all(allLevelFiles.map(async (file) => {
            try {
                // Normalize the path to use forward slashes and ensure it's absolute
                const normalizedPath = path.isAbsolute(file.path) 
                    ? file.path.replace(/\\/g, '/')
                    : path.resolve(file.path).replace(/\\/g, '/');

                const levelData = await LevelService.readLevelFile(normalizedPath);
                const analysis = LevelService.analyzeLevelData(levelData);
                
                return {
                    name: file.name,
                    size: file.size,
                    hasYouTubeStream: analysis.hasYouTubeStream,
                    songFilename: levelData.settings?.songFilename,
                    artist: levelData.settings?.artist,
                    song: levelData.settings?.song,
                    author: levelData.settings?.author,
                    difficulty: levelData.settings?.difficulty,
                    bpm: levelData.settings?.bpm
                };
            } catch (error) {
                logger.error('Failed to analyze level file:', {
                    error: error instanceof Error ? error.message : String(error),
                    path: file.path,
                    normalizedPath: path.isAbsolute(file.path) 
                        ? file.path.replace(/\\/g, '/')
                        : path.resolve(file.path).replace(/\\/g, '/')
                });
                return {
                    name: file.name,
                    size: file.size,
                    error: 'Failed to analyze level file'
                };
            }
        }));

        logger.info('Successfully retrieved level files:', {
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

// Level zip upload endpoint
router.post('/', (req: Request, res: Response) => {
    logger.info('Received zip upload request');
    
    storageManager.upload(req, res, async (err) => {
        if (err) {
            logger.error('Multer error during zip upload:', {
                error: err.message,
                code: err.code,
                field: err.field,
                stack: err.stack
            });
            return res.status(400).json({ error: err.message });
        }

        if (!req.file) {
            logger.warn('Zip upload attempt with no file');
            return res.status(400).json({ error: 'No file uploaded' });
        }

        logger.info('Processing uploaded zip file:', {
            filename: req.file.filename,
            size: req.file.size,
            mimetype: req.file.mimetype,
            path: req.file.path
        });

        try {
            // Generate a UUID for the database entry
            const fileId = crypto.randomUUID();
            logger.info('Generated UUID for database entry:', { fileId });
            
            // Process zip file first to validate contents
            logger.info('Starting zip file processing');
            await processZipFile(req.file.path, fileId, req.file.originalname);
            logger.info('Successfully processed zip file');

            // Clean up the original zip file since we've extracted what we need
            logger.info('Cleaning up original zip file');
            storageManager.cleanupFiles(req.file.path);
            logger.info('Original zip file cleaned up');

            const response = {
                success: true,
                fileId: fileId,
                url: `${CDN_CONFIG.baseUrl}/${fileId}`,
            };
            logger.info('Zip upload completed successfully:', response);
            
            res.json(response);
        } catch (error) {
            logger.error('Error during zip upload process:', {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
                file: req.file ? {
                    originalname: req.file.originalname,
                    size: req.file.size,
                    path: req.file.path
                } : null
            });
            
            storageManager.cleanupFiles(req.file.path);

            // Try to parse error message if it's JSON
            let errorDetails;
            try {
                const parsedError = JSON.parse(error instanceof Error ? error.message : String(error));
                errorDetails = {
                    message: parsedError.details?.message || parsedError.message,
                    ...parsedError.details
                };
            } catch {
                errorDetails = {
                    message: error instanceof Error ? error.message : String(error)
                };
            }

            res.status(400).json({ 
                error: errorDetails.message,
                code: 'VALIDATION_ERROR',
                details: errorDetails
            });
        }
        return;
    });
    return;
});

// Set target level endpoint
router.put('/:fileId/target-level', async (req: Request, res: Response) => {
    const { fileId } = req.params;
    const { targetLevel } = req.body;
    
    logger.info('Setting target level for zip:', { fileId, targetLevel });
    
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

        const metadata = levelEntry.metadata as {
            allLevelFiles: Array<{
                name: string;
                path: string;
                size: number;
                hasYouTubeStream?: boolean;
                songFilename?: string;
            }>;
            targetLevel: string | null;
            pathConfirmed: boolean;
        };

        // Get the target filename regardless of path
        const targetFilename = path.basename(targetLevel);

        // Find matching level file by recursively checking paths
        const matchingLevel = metadata.allLevelFiles.find(file => {
            const filePath = file.path.replace(/\\/g, '/');
            const targetPath = targetLevel.replace(/\\/g, '/');
            
            // Direct path match
            if (filePath === targetPath) {
                return true;
            }
            
            // Filename match
            if (path.basename(filePath) === targetFilename) {
                return true;
            }
            
            // Check if target is a relative path and matches any subdirectory
            if (!path.isAbsolute(targetPath)) {
                const fileDir = path.dirname(filePath);
                const targetDir = path.dirname(targetPath);
                return fileDir.endsWith(targetDir) && path.basename(filePath) === targetFilename;
            }
            
            return false;
        });

        if (!matchingLevel) {
            logger.error('Target level not found in zip:', {
                fileId,
                targetLevel,
                targetFilename,
                availableLevels: metadata.allLevelFiles.map(f => ({
                    path: f.path,
                    name: f.name
                }))
            });
            return res.status(400).json({ error: 'Target level not found in zip' });
        }

        // Update metadata with the actual file path from the zip
        await levelEntry.update({
            metadata: {
                ...metadata,
                targetLevel: matchingLevel.path,
                pathConfirmed: true
            }
        });

        logger.info('Successfully set target level:', {
            fileId,
            targetLevel: matchingLevel.path,
            originalTarget: targetLevel,
            timestamp: new Date().toISOString()
        });

        res.json({
            success: true,
            fileId,
            targetLevel: matchingLevel.path
        });
    } catch (error) {
        logger.error('Error setting target level:', {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            fileId,
            targetLevel
        });
        res.status(500).json({ error: 'Failed to set target level' });
    }
    return;
});

export default router;
