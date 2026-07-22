import { Router, Request, Response } from 'express';
import { logger } from '@/server/services/core/LoggerService.js';
import CdnFile from '@/models/cdn/CdnFile.js';
import { spacesStorage } from '@/externalServices/cdnService/infra/storage/spacesStorage.js';
import type LevelDict from 'adofai-lib';
import { AnalysisCacheData, levelCacheService } from '@/externalServices/cdnService/services/levelCacheService.js';
import { CDN_CONFIG } from '@/externalServices/cdnService/config.js';
import { ArchivePathError } from '@/externalServices/cdnService/domain/archive/ingestPaths.js';
import {
    buildLevelZipFileContents,
    parseClientRelativePath,
    resolveChartStoragePathFromMetadata,
    resolveSongFileForTransform
} from './shared/routeUtils.js';

const router = Router();

function loadLevelZipOrThrow(file: CdnFile | null): CdnFile {
    if (!file) {
        throw { error: 'File not found', code: 404 };
    }
    if (file.type !== 'LEVELZIP') {
        throw { error: 'File is not a level zip', code: 400 };
    }
    return file;
}

async function redirectToStorageObject(res: Response, storagePath: string): Promise<void> {
    const exists = await spacesStorage.fileExists(storagePath);
    if (!exists) {
        throw { error: 'File not found in storage', code: 404 };
    }
    const cdnUrl = await spacesStorage.getPresignedUrl(storagePath);
    res.setHeader('Cache-Control', CDN_CONFIG.cacheControl);
    res.redirect(301, cdnUrl);
}

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

/** Manifest of extracted charts + songs with public object URLs (from LEVELZIP metadata). */
router.get('/:fileId/contents', async (req: Request, res: Response) => {
    try {
        const file = loadLevelZipOrThrow(await CdnFile.findByPk(req.params.fileId));
        return res.json(buildLevelZipFileContents(file.metadata));
    } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && 'error' in error) {
            const customError = error as { code: number; error: string };
            return res.status(customError.code).json({ error: customError.error });
        }
        logger.error('Unexpected error getting contents for ' + req.params.fileId + ':', error);
        return res.status(500).json({ error: 'Unexpected error getting level contents' });
    }
});

/** Allowlisted redirect to a chart object by archive-relative path (or unique basename). */
router.get('/:fileId/chart', async (req: Request, res: Response) => {
    try {
        const file = loadLevelZipOrThrow(await CdnFile.findByPk(req.params.fileId));
        let selection: string;
        try {
            selection = parseClientRelativePath(req.query.path);
        } catch (error) {
            if (error instanceof ArchivePathError) {
                throw { error: error.message, code: 400 };
            }
            throw error;
        }
        const storagePath = resolveChartStoragePathFromMetadata(file.metadata, selection);
        if (!storagePath) {
            throw { error: 'Chart file not found in metadata', code: 404 };
        }
        await redirectToStorageObject(res, storagePath);
        return;
    } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && 'error' in error) {
            const customError = error as { code: number; error: string };
            return res.status(customError.code).json({ error: customError.error });
        }
        logger.error('Unexpected error getting chart for ' + req.params.fileId + ':', error);
        return res.status(500).json({ error: 'Unexpected error getting chart file' });
    }
});

/**
 * Allowlisted redirect to a song object. `path` may be relative or basename;
 * optional `levelPath` disambiguates same-basename songs in multi-folder packs.
 */
router.get('/:fileId/song', async (req: Request, res: Response) => {
    try {
        const file = loadLevelZipOrThrow(await CdnFile.findByPk(req.params.fileId));
        let songPath: string;
        try {
            songPath = parseClientRelativePath(req.query.path);
        } catch (error) {
            if (error instanceof ArchivePathError) {
                throw { error: error.message, code: 400 };
            }
            throw error;
        }

        let levelPath: string | undefined;
        if (typeof req.query.levelPath === 'string' && req.query.levelPath.trim() !== '') {
            try {
                levelPath = parseClientRelativePath(req.query.levelPath);
            } catch (error) {
                if (error instanceof ArchivePathError) {
                    throw { error: error.message, code: 400 };
                }
                throw error;
            }
        }

        const metadata = (file.metadata ?? {}) as {
            songFiles?: Record<string, { name: string; path: string; size: number; type: string }>;
            targetLevelRelativePath?: string;
        };
        const songFiles = metadata.songFiles;
        if (!songFiles || typeof songFiles !== 'object') {
            throw { error: 'No song files found in metadata', code: 404 };
        }

        const resolved = resolveSongFileForTransform(
            songFiles,
            songPath,
            levelPath ?? metadata.targetLevelRelativePath
        );
        if (!resolved?.path) {
            throw { error: 'Song file not found in metadata', code: 404 };
        }
        await redirectToStorageObject(res, resolved.path);
        return;
    } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && 'error' in error) {
            const customError = error as { code: number; error: string };
            return res.status(customError.code).json({ error: customError.error });
        }
        logger.error('Unexpected error getting song for ' + req.params.fileId + ':', error);
        return res.status(500).json({ error: 'Unexpected error getting song file' });
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
            throw { error: 'Target level file not found in metadata', code: 404 };
        }

        const levelExists = await spacesStorage.fileExists(targetLevel);

        if (!levelExists) {
            throw { error: 'Target level file not found in storage', code: 404 };
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
