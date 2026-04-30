import { logger } from '@/server/services/core/LoggerService.js';
import CdnFile from '@/models/cdn/CdnFile.js';
import { parseChartStatsFromCache } from '@/misc/utils/data/chartCacheParse.js';
import { computeLevelCacheMetadataSignature } from '../levelCacheSignature.js';
import type { OversizedMinimalCache, OversizedZipMetadata } from './levelCacheOversizedTypes.js';
import { performOversizedCacheBackfill } from './levelCacheOversizedBackfill.js';

function tryParseOversizedCache(cacheDataString: string | null): OversizedMinimalCache | null {
    if (!cacheDataString) return null;
    try {
        return JSON.parse(cacheDataString) as OversizedMinimalCache;
    } catch {
        return null;
    }
}

function isOversizedCacheComplete(cacheData: OversizedMinimalCache, metadata: OversizedZipMetadata): boolean {
    if (cacheData._metadataSignature !== computeLevelCacheMetadataSignature(metadata)) {
        return false;
    }
    if (typeof cacheData.tilecount !== 'number' || !Number.isFinite(cacheData.tilecount)) {
        return false;
    }
    if (!cacheData.settings || typeof cacheData.settings !== 'object') {
        return false;
    }
    const stats = parseChartStatsFromCache(JSON.stringify(cacheData));
    if (stats.bpm === null) {
        return false;
    }
    if (stats.levelLengthInMs === null) {
        return false;
    }
    if (
        !cacheData.transformOptions ||
        !Array.isArray(cacheData.transformOptions.eventTypes) ||
        !Array.isArray(cacheData.transformOptions.filterTypes) ||
        !Array.isArray(cacheData.transformOptions.advancedFilterTypes)
    ) {
        return false;
    }
    return true;
}

/**
 * Ensures persisted `cacheData` for an oversized target level: reuse if complete for current metadata,
 * otherwise download `originalZip`, scan level + audio, and persist minimal cache.
 */
export async function ensureOversizedMinimalCache(params: {
    file: CdnFile;
    metadata: OversizedZipMetadata;
    targetLevel: string;
}): Promise<OversizedMinimalCache | null> {
    const { file, metadata, targetLevel } = params;
    const existing = tryParseOversizedCache(file.cacheData);
    if (existing && isOversizedCacheComplete(existing, metadata)) {
        logger.debug('refreshCache: oversized target already has minimal cache; skipping rebuild', {
            fileId: file.id
        });
        return existing;
    }

    logger.debug('refreshCache: oversized target, building minimal cache', { fileId: file.id });
    const rebuilt = await performOversizedCacheBackfill({ file, metadata, targetLevel });
    if (!rebuilt) {
        return existing ?? null;
    }
    return rebuilt;
}
