import { logger } from '@/server/services/core/LoggerService.js';
import { computeLevelCacheMetadataSignature } from './levelCacheSignature.js';
import {
    ANALYSIS_FORMAT_VERSION,
    REQUIRED_ANALYSIS_KEYS,
    SAFE_TO_PARSE_VERSION,
    type AnalysisCacheData,
    type LevelCacheData
} from './levelCacheContracts.js';

export function isVersionCurrent(metadata: any): boolean {
    const storedVersion = metadata?.targetSafeToParseVersion;
    return storedVersion === SAFE_TO_PARSE_VERSION;
}

export function analysisHasExpectedShape(analysis: AnalysisCacheData | undefined): boolean {
    if (!analysis || analysis._version !== ANALYSIS_FORMAT_VERSION) {
        return false;
    }
    for (const key of REQUIRED_ANALYSIS_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(analysis, key)) {
            return false;
        }
    }
    const ng = analysis.nonGameplayEventCounts;
    if (typeof ng !== 'object' || ng === null || typeof (ng as { total?: unknown }).total !== 'number') {
        return false;
    }
    return true;
}

/**
 * Single gate for whether persisted cache matches current contract (metadata + shape + versions).
 */
export function isLevelCacheFullyValid(cacheData: LevelCacheData, metadata: any): boolean {
    if (!isVersionCurrent(metadata)) {
        return false;
    }
    if (cacheData._metadataSignature !== computeLevelCacheMetadataSignature(metadata)) {
        return false;
    }
    if (cacheData.tilecount === undefined || cacheData.settings === undefined) {
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
    return analysisHasExpectedShape(cacheData.analysis);
}

/**
 * Deserialize DB `cacheData` JSON and apply safe-to-parse / invalidation.
 */
export function parseStoredCacheJson(cacheDataString: string | null, metadata?: any): LevelCacheData | null {
    if (!cacheDataString) {
        return null;
    }
    if (metadata !== undefined && !isVersionCurrent(metadata)) {
/*        logger.debug('Cache invalidated due to version mismatch', {
            storedVersion: metadata?.targetSafeToParseVersion,
            currentVersion: SAFE_TO_PARSE_VERSION
        });*/
        return null;
    }

    try {
        return JSON.parse(cacheDataString) as LevelCacheData;
    } catch (error) {
        logger.error('Failed to parse cache data:', error);
        return null;
    }
}

