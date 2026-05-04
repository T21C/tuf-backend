import { Router, Request, Response } from 'express';
import { logger } from '@/server/services/core/LoggerService.js';
import CdnFile from '@/models/cdn/CdnFile.js';
import { levelCacheService } from '@/externalServices/cdnService/services/levelCacheService.js';
import { parseChartStatsFromCache } from '@/misc/utils/data/chartCacheParse.js';
import { Op } from 'sequelize';
import { buildPublicLevelzipCdnMetadata } from './shared/routeUtils.js';

const router = Router();

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
                metadata: buildPublicLevelzipCdnMetadata(metadata)
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

/** Denormalized chart fields from persisted cache (main server must not read `CdnFile` directly). */
router.get('/:fileId/chart-stats', async (req: Request, res: Response) => {
    try {
        const { fileId } = req.params;
        if (!fileId) {
            return res.status(400).json({ error: 'File ID is required' });
        }
        const file = await CdnFile.findByPk(fileId, { attributes: ['id', 'type', 'cacheData', 'metadata'] });
        if (!file) {
            return res.status(404).json({ error: 'File not found' });
        }
        if (file.type !== 'LEVELZIP') {
            return res.json({ bpm: null, tilecount: null, levelLengthInMs: null });
        }
        const stats = parseChartStatsFromCache(file.cacheData ?? null);
        return res.json(stats);
    } catch (error) {
        logger.error('chart-stats error for ' + req.params.fileId + ':', error);
        return res.status(500).json({ error: 'Unexpected error getting chart stats' });
    }
});

/** Clear/rebuild level zip cache, return fresh denormalized chart fields (same source as chart-stats after write). */
router.post('/:fileId/chart-cache/refresh', async (req: Request, res: Response) => {
    try {
        const { fileId } = req.params;
        if (!fileId) {
            return res.status(400).json({ error: 'File ID is required' });
        }
        const file = await CdnFile.findByPk(fileId);
        if (!file) {
            return res.status(404).json({ error: 'File not found' });
        }
        if (file.type !== 'LEVELZIP') {
            return res.json({ bpm: null, tilecount: null, levelLengthInMs: null });
        }
        const metadata = file.metadata as {
            targetLevelOversized?: boolean;
        };
        if (metadata?.targetLevelOversized) {
            const stats = parseChartStatsFromCache(file.cacheData ?? null);
            return res.json(stats);
        }
        await levelCacheService.clearCache(file);
        await file.reload();
        await levelCacheService.refreshCache(fileId);
        await file.reload();
        const stats = parseChartStatsFromCache(file.cacheData ?? null);
        return res.json(stats);
    } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && 'error' in error) {
            const customError = error as { code: number; error: string };
            return res.status(customError.code).json({ error: customError.error });
        }
        logger.error('chart-cache refresh error for ' + req.params.fileId + ':', error);
        return res.status(500).json({ error: 'Unexpected error refreshing chart cache' });
    }
});
export default router;
