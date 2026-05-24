import { Router, Request, Response } from 'express';
import { logger } from '@/server/services/core/LoggerService.js';
import CdnFile from '@/models/cdn/CdnFile.js';
import { spacesStorage } from '@/externalServices/cdnService/infra/storage/spacesStorage.js';
import type LevelDict from 'adofai-lib';
import { AnalysisCacheData, levelCacheService } from '@/externalServices/cdnService/services/levelCacheService.js';
import { CDN_CONFIG } from '@/externalServices/cdnService/config.js';

const router = Router();

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
        return res.json(levelData.toJSON());
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
            response.durations = durations.filter((d: number | undefined): d is number => d !== undefined);
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
            targetLevelOversized?: boolean;
        };
        const targetLevel = metadata.targetLevel || metadata.allLevelFiles?.[0]?.path;
        if (!targetLevel) {
            throw { error: 'Target level file not found in metadata', code: 400 };
        }

        const levelExists = await spacesStorage.fileExists(targetLevel);

        if (!levelExists) {
            throw { error: 'Target level file not found in storage', code: 400 };
        }

        const cdnUrl = await spacesStorage.getPresignedUrl(targetLevel);
        res.setHeader('Cache-Control', CDN_CONFIG.cacheControl);
        return res.redirect(301, cdnUrl);
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
