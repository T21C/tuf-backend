import { logger } from '@/server/services/core/LoggerService.js';
import CdnFile from '@/models/cdn/CdnFile.js';
import LevelDict, { analysisUtils } from 'adofai-lib';
import dotenv from 'dotenv';
import { spacesStorage } from '../infra/storage/spacesStorage.js';
import { CdnSpacesTempDomain, withCdnFileDomainWorkspace } from '../infra/workspaces/cdnSpacesTemp.js';
import { PROTECTED_EVENT_TYPES } from './levelTransformer.js';
import { ensureOversizedMinimalCache } from '../domain/level/oversizedHandling/levelCacheOversized.js';
import type { OversizedZipMetadata } from '../domain/level/oversizedHandling/levelCacheOversizedTypes.js';
import {
    SAFE_TO_PARSE_VERSION,
    type LevelCacheData
} from '../domain/level/levelCacheContracts.js';
import {
    isVersionCurrent,
    isLevelCacheFullyValid,
    parseStoredCacheJson
} from '../domain/level/levelCacheValidation.js';
import { buildFullCachePayload } from '../domain/level/levelCacheBuild.js';
import { downloadLevelToWorkspace, extractSourceCopyFromMetadata } from '../infra/level/levelSourceBytes.js';

dotenv.config();

export { SAFE_TO_PARSE_VERSION };
export type { AnalysisCacheData, LevelCacheData } from '../domain/level/levelCacheContracts.js';

/**
 * Stable signature for metadata fields that affect level cache semantics.
 * Extend the picked object when new metadata drives parse/cache behavior.
 */
export { computeLevelCacheMetadataSignature } from '../domain/level/levelCacheSignature.js';

/**
 * Unified service for managing level file cache data
 */
class LevelCacheService {
    private static instance: LevelCacheService;

    private constructor() {}

    static getInstance(): LevelCacheService {
        if (!LevelCacheService.instance) {
            LevelCacheService.instance = new LevelCacheService();
        }
        return LevelCacheService.instance;
    }

    // cache validity helpers extracted into domain/level/levelCacheValidation.ts

    // level source-byte helpers extracted into infra/level/levelSourceBytes.ts

    /**
     * Prefer the byte-for-byte source copy when re-normalizing so pathData and other
     * author-specific formatting are not lost via an intermediate angleData canonical file.
     */
    private async resolveParseSourcePath(
        file: CdnFile,
        targetLevelPath: string,
        fileMetadata: any,
        canonicalLocalPath: string,
        join: (...parts: string[]) => string
    ): Promise<string> {
        const extracted = await extractSourceCopyFromMetadata({
            file,
            targetLevelPath: targetLevelPath,
            metadata: fileMetadata,
            join
        });
        if (extracted) {
            return extracted.localPath;
        }
        logger.warn('No source copy for target level; parsing canonical storage object', {
            fileId: file.id,
            targetLevelPath
        });
        return canonicalLocalPath;
    }

    /**
     * Write canonical level JSON via LevelDict (respects preserveAngleFormat) and upload to storage.
     */
    async persistCanonicalLevel(
        levelData: LevelDict,
        localPath: string,
        storagePath: string
    ): Promise<void> {
        levelData.writeToFile(localPath);
        await spacesStorage.uploadFile(localPath, storagePath, 'application/json');
    }

    /**
     * Mark the target level object as normalized for the current safe-to-parse contract version.
     */
    async markTargetSafeToParse(file: CdnFile, metadata?: any): Promise<void> {
        const fileMetadata = metadata ?? (file.metadata as Record<string, unknown>);
        await file.update({
            metadata: {
                ...fileMetadata,
                targetSafeToParse: true,
                targetSafeToParseVersion: SAFE_TO_PARSE_VERSION
            }
        });
    }

    /**
     * Load level data with proper version checking and cache management.
     * This is the SINGLE entry point for loading level files - use this instead of
     * manually checking safeToParse.
     *
     * @param file - CdnFile instance
     * @param levelPath - Path to the level file
     * @param metadata - Optional metadata object (will use file.metadata if not provided)
     * @returns Object containing the parsed LevelDict and whether it was reparsed
     */
    async loadLevelData(
        file: CdnFile,
        levelPath: string,
        metadata?: any
    ): Promise<{ levelData: LevelDict; wasReparsed: boolean }> {
        const fileMetadata = metadata || file.metadata as any;

        if (fileMetadata?.targetLevelOversized) {
            throw new Error('Level file is too large to parse (oversized); cache and level data are not available');
        }

        return withCdnFileDomainWorkspace(
            CdnSpacesTempDomain.LevelCache,
            file.id,
            async ({ join }) => {
                const resolvedLevel = await downloadLevelToWorkspace(levelPath, join);

                const safeToParse = fileMetadata?.targetSafeToParse || false;
                const versionCurrent = isVersionCurrent(fileMetadata);

                const needsReparse = !safeToParse || !versionCurrent;

                if (needsReparse) {
                    if (safeToParse && !versionCurrent) {
                        logger.debug('SafeToParse version outdated, re-normalizing from source copy', {
                            fileId: file.id,
                            storedVersion: fileMetadata?.targetSafeToParseVersion,
                            currentVersion: SAFE_TO_PARSE_VERSION
                        });
                    }

                    const sourceToUse = await this.resolveParseSourcePath(
                        file,
                        levelPath,
                        fileMetadata,
                        resolvedLevel.localPath,
                        join
                    );

                    const levelData = new LevelDict(sourceToUse);

                    await this.persistCanonicalLevel(levelData, resolvedLevel.localPath, levelPath);
                    await this.markTargetSafeToParse(file, fileMetadata);

                    logger.debug('Level file loaded and version updated', {
                        fileId: file.id,
                        version: SAFE_TO_PARSE_VERSION,
                        sourceUsed: sourceToUse
                    });
                    return { levelData, wasReparsed: true };
                }

                const levelData = new LevelDict(resolvedLevel.localPath);
                return { levelData, wasReparsed: false };
            }
        );
    }

    /**
     * Deserialize DB `cacheData` JSON and apply safe-to-parse / dev invalidation.
     */
    private parseStoredCacheJson(cacheDataString: string | null, metadata?: any): LevelCacheData | null {
        return parseStoredCacheJson(cacheDataString, metadata);
    }

    private async buildAndPersistFullCache(
        file: CdnFile,
        levelPath: string,
        metadata: any,
        parsedLevelData: LevelDict
    ): Promise<LevelCacheData> {
        const cacheData: LevelCacheData = buildFullCachePayload({
            parsedLevelData,
            metadata,
            protectedEventTypes: PROTECTED_EVENT_TYPES
        });

        logger.debug('dlc events', { dlcEvents: analysisUtils.getDLCEvents(parsedLevelData) });

        await file.update({ cacheData: JSON.stringify(cacheData) });

        logger.debug('Cache populated successfully:', {
            fileId: file.id,
            tilecount: cacheData.tilecount,
            hasSettings: !!cacheData.settings,
            hasAnalysis: !!cacheData.analysis
        });

        return cacheData;
    }

    /**
     * Single entry: return valid cache from DB or load level, build full cache, persist, return.
     */
    async getLevelCache(
        file: CdnFile,
        levelPath: string,
        metadata?: any,
        preloadedLevelData?: LevelDict
    ): Promise<{ cacheData: LevelCacheData; levelData?: LevelDict; refreshed: boolean }> {
        const fileMetadata = metadata || file.metadata as any;
        if (fileMetadata?.targetLevelOversized) {
            throw new Error('Level file is too large to parse (oversized); cannot populate cache');
        }

        const levelCheck = await spacesStorage.fileExists(levelPath);
        if (!levelCheck) {
            throw new Error(`Level file not found in storage: ${levelPath}`);
        }

        const parsed = this.parseStoredCacheJson(file.cacheData, fileMetadata);
        if (parsed && isLevelCacheFullyValid(parsed, fileMetadata)) {
            return { cacheData: parsed, refreshed: false };
        }

        let levelData: LevelDict;
        if (preloadedLevelData) {
            levelData = preloadedLevelData;
        } else {
            const result = await this.loadLevelData(file, levelPath, metadata);
            levelData = result.levelData;
        }

        await file.reload();
        const metaForSignature = file.metadata as any;

        const cacheData = await this.buildAndPersistFullCache(file, levelPath, metaForSignature, levelData);
        return { cacheData, levelData, refreshed: true };
    }

    /**
     * Populate cache for a level file (full tilecount, settings, analysis). Prefer {@link getLevelCache}.
     */
    async populateCache(
        file: CdnFile,
        levelPath: string,
        metadata?: any,
        levelData?: LevelDict
    ): Promise<LevelCacheData> {
        try {
            logger.debug('Populating cache for file:', { fileId: file.id, levelPath });
            const { cacheData } = await this.getLevelCache(file, levelPath, metadata, levelData);
            return cacheData;
        } catch (error) {
            logger.error('Failed to populate cache:', {
                fileId: file.id,
                levelPath,
                error: error instanceof Error ? error.message : String(error)
            });
            throw error;
        }
    }

    /**
     * Clear cache for a file
     * @param file - CdnFile instance
     */
    async clearCache(file: CdnFile): Promise<void> {
        try {
            await file.update({ cacheData: null });
            logger.debug('Cache cleared for file:', { fileId: file.id });
        } catch (error) {
            logger.error('Failed to clear cache:', {
                fileId: file.id,
                error: error instanceof Error ? error.message : String(error)
            });
            throw error;
        }
    }

    /**
     * Rebuild persisted `cacheData` for the current {@link CdnFile} metadata target (object key in R2).
     * Call when the effective target level changes (e.g. after `PUT .../target-level`) or after clearing cache.
     * Ingest paths populate cache in {@link processArchiveFile}; this is not run on every upload.
     *
     * @param fileId - LEVELZIP row id
     * @returns New cache payload or null if the row is missing / not a zip / cannot rebuild
     */
    async refreshCache(fileId: string): Promise<LevelCacheData | null> {
        try {
            const file = await CdnFile.findByPk(fileId);
            if (!file) {
                logger.debug('refreshCache: file not found', { fileId });
                return null;
            }

            if (file.type !== 'LEVELZIP') {
                logger.debug('refreshCache: not a level zip', { fileId, type: file.type });
                return null;
            }

            const metadata = file.metadata as OversizedZipMetadata;

            if (!metadata.allLevelFiles || metadata.allLevelFiles.length === 0) {
                logger.debug('refreshCache: no level files in metadata', { fileId });
                return null;
            }

            // Determine target level
            const targetLevel = metadata.targetLevel || metadata.allLevelFiles[0].path;

            const levelCheck = await spacesStorage.fileExists(targetLevel);
            if (!levelCheck) {
                logger.debug('refreshCache: target level not in storage', { fileId, targetLevel });
                return null;
            }

            // Oversized levels: minimal cache only (no full LevelDict).
            if (metadata.targetLevelOversized) {
                const minimal = await ensureOversizedMinimalCache({ file, metadata, targetLevel });
                return (minimal as LevelCacheData | null) ?? null;
            }

            const { cacheData } = await this.getLevelCache(file, targetLevel, metadata);
            return cacheData;
        } catch (error) {
            logger.error('refreshCache: failed', {
                fileId,
                error: error instanceof Error ? error.message : String(error)
            });
            return null;
        }
    }

    /**
     * Get durations from an existing CDN file
     * Returns null if file doesn't exist or can't be parsed
     */
    async getDurationsFromCdnFile(fileId: string): Promise<number[] | null> {
        const cdnFile = await CdnFile.findByPk(fileId);

        if (!cdnFile) {
            return null;
        }

        try {
            // Get the level file path from CDN
            const metadata = cdnFile.metadata as any;
            if (!metadata?.targetLevel) {
                return null;
            }

            const levelPath = metadata.targetLevel;

            // Check if file exists
            const fileCheck = await spacesStorage.fileExists(levelPath);
            if (!fileCheck) {
                return null;
            }

            // Load and parse the level file
            const { levelData } = await this.loadLevelData(cdnFile, levelPath, metadata);

            // Get durations and filter out undefined values
            const durations = levelData.getDurations();
            return durations.filter((d): d is number => d !== undefined);
        } catch (error) {
            logger.error('Failed to get durations from CDN file:', {
                fileId,
                error: error instanceof Error ? error.message : String(error)
            });
            return null;
        }
    }
}

export const levelCacheService = LevelCacheService.getInstance();

