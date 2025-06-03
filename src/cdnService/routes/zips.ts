import path from "path";
import { logger } from "../../services/LoggerService.js";
import { cleanupFiles, upload } from "../services/storage.js";
import { CDN_CONFIG } from "../config.js";
import { processZipFile } from "../services/zipProcessor.js";
import { Request, Response, Router } from 'express';
import CdnFile from "../../models/cdn/CdnFile.js";
import { LevelAnalyzer } from "../services/levelAnalyzer.js";

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
                const levelData = await LevelAnalyzer.readLevelFile(path.join(CDN_CONFIG.file_root, file.path));
                const analysis = LevelAnalyzer.analyzeLevelData(levelData);
                
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
                    path: file.path
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
    
    upload(req, res, async (err) => {
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
            const fileId = path.parse(req.file.filename).name;
            logger.info('Generated file ID for zip:', { fileId });
            
            // Process zip file first to validate contents
            logger.info('Starting zip file processing');
            await processZipFile(req.file.path, fileId);
            logger.info('Successfully processed zip file');

            // Clean up the original zip file since we've extracted what we need
            logger.info('Cleaning up original zip file');
            cleanupFiles(req.file.path);
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
            
            cleanupFiles(req.file.path);

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

        // Verify the target level exists in the zip
        const levelExists = metadata.allLevelFiles.some(file => 
            path.basename(file.path) === path.basename(targetLevel)
        );
        if (!levelExists) {
            logger.error('Target level not found in zip:', {
                fileId,
                targetLevel,
                availableLevels: metadata.allLevelFiles.map(f => path.basename(f.path))
            });
            return res.status(400).json({ error: 'Target level not found in zip' });
        }

        // Update metadata
        await levelEntry.update({
            metadata: {
                ...metadata,
                targetLevel,
                pathConfirmed: true
            }
        });

        logger.info('Successfully set target level:', {
            fileId,
            targetLevel,
            timestamp: new Date().toISOString()
        });

        res.json({
            success: true,
            fileId,
            targetLevel
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
