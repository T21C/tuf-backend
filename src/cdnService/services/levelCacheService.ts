import { logger } from '../../services/LoggerService.js';
import CdnFile from '../../models/cdn/CdnFile.js';
import LevelDict, { analysisUtils, constants } from 'adofai-lib';
import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import dotenv from 'dotenv';
import { hybridStorageManager, StorageType } from './hybridStorageManager.js';

dotenv.config();

/**
 * Version number for the safe-to-parse flag.
 * Increment this when breaking changes are made to the level parsing logic
 * to force re-parsing of all cached levels.
 */
export const SAFE_TO_PARSE_VERSION = 1;

// Cache data structure
export interface LevelCacheData {
    tilecount?: number;
    settings?: any;
    analysis?: {
        containsDLC?: boolean;
        dlcEvents?: string[];
        canDecorationsKill?: boolean;
        isJudgementLimited?: boolean;
        levelLengthInMs?: number;
        vfxTier?: constants.VfxTier;
        requiredMods?: string[];
    };
}

// Cache hit result for checking what data is available
export interface CacheHitResult {
    tilecount: boolean;
    settings: boolean;
    analysis: boolean;
    accessCount: boolean; // Always available from file record
}

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

    /**
     * Check if the safeToParse version is current
     */
    private isVersionCurrent(metadata: any): boolean {
        const storedVersion = metadata?.targetSafeToParseVersion;
        return storedVersion === SAFE_TO_PARSE_VERSION;
    }

    /**
     * Get the source.copy path for a target level file
     */
    private getSourceCopyPath(targetLevelPath: string): string {
        const dir = path.dirname(targetLevelPath);
        return path.join(dir, 'source.copy');
    }

    /**
     * Extract the original .adofai file from the zip and save as source.copy
     * This preserves the untouched original before LevelDict modifies it
     */
    private async extractSourceCopy(
        file: CdnFile,
        targetLevelPath: string,
        metadata: any
    ): Promise<string | null> {
        try {
            const sourceCopyPath = this.getSourceCopyPath(targetLevelPath);

            // Get the original zip info from metadata
            const originalZip = metadata?.originalZip;
            if (!originalZip?.path) {
                logger.warn('No original zip path in metadata, cannot extract source copy', {
                    fileId: file.id
                });
                return null;
            }

            // Determine storage type for the zip
            const zipStorageType = (originalZip.storageType as StorageType) || 
                                   (metadata.storageInfo?.zip as StorageType) || 
                                   StorageType.LOCAL;

            // Download the zip to a temporary location
            const tempDir = path.dirname(targetLevelPath);
            const tempZipPath = path.join(tempDir, `temp_${file.id}.zip`);

            logger.debug('Downloading zip for source copy extraction', {
                fileId: file.id,
                zipPath: originalZip.path,
                storageType: zipStorageType,
                tempZipPath
            });

            await hybridStorageManager.downloadFile(originalZip.path, zipStorageType, tempZipPath);

            // Find the target level file name in the zip
            // The targetLevelPath might be a Spaces key or local path, we need the original filename
            const allLevelFiles = metadata?.allLevelFiles || [];
            let targetLevelName: string | null = null;

            for (const levelFile of allLevelFiles) {
                if (levelFile.path === targetLevelPath) {
                    targetLevelName = levelFile.name;
                    break;
                }
            }

            if (!targetLevelName) {
                // Fallback: try to extract basename from path
                targetLevelName = path.basename(targetLevelPath);
                logger.debug('Using basename as target level name fallback', {
                    targetLevelName,
                    targetLevelPath
                });
            }

            // Open the zip and find the target .adofai file
            const zip = new AdmZip(tempZipPath);
            const entries = zip.getEntries();

            let foundEntry: AdmZip.IZipEntry | null = null;
            for (const entry of entries) {
                if (entry.name === targetLevelName || entry.entryName.endsWith(targetLevelName)) {
                    foundEntry = entry;
                    break;
                }
            }

            if (!foundEntry) {
                logger.warn('Target level file not found in zip', {
                    fileId: file.id,
                    targetLevelName,
                    availableEntries: entries.map(e => e.name)
                });
                // Clean up temp zip
                await fs.promises.unlink(tempZipPath).catch(() => {});
                return null;
            }

            // Extract the original content and save as source.copy
            const originalContent = foundEntry.getData();
            await fs.promises.mkdir(path.dirname(sourceCopyPath), { recursive: true });
            await fs.promises.writeFile(sourceCopyPath, originalContent);

            logger.debug('Source copy extracted successfully', {
                fileId: file.id,
                sourceCopyPath,
                size: originalContent.length
            });

            // Clean up temp zip
            await fs.promises.unlink(tempZipPath).catch(() => {});

            return sourceCopyPath;
        } catch (error) {
            logger.error('Failed to extract source copy', {
                fileId: file.id,
                error: error instanceof Error ? error.message : String(error)
            });
            return null;
        }
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
        const safeToParse = fileMetadata?.targetSafeToParse || false;
        const versionCurrent = this.isVersionCurrent(fileMetadata);
        
        // Determine if we need to re-parse from original source
        const needsReparse = !safeToParse || !versionCurrent;

        if (needsReparse) {
            let sourceToUse = levelPath;

            // If version is outdated, we need to use the original source
            if (safeToParse && !versionCurrent) {
                logger.info('SafeToParse version outdated, extracting original source', {
                    fileId: file.id,
                    storedVersion: fileMetadata?.targetSafeToParseVersion,
                    currentVersion: SAFE_TO_PARSE_VERSION
                });

                // Check if source.copy already exists
                const sourceCopyPath = this.getSourceCopyPath(levelPath);
                if (fs.existsSync(sourceCopyPath)) {
                    sourceToUse = sourceCopyPath;
                    logger.debug('Using existing source.copy', { sourceCopyPath });
                } else {
                    // Extract source.copy from the original zip
                    const extractedPath = await this.extractSourceCopy(file, levelPath, fileMetadata);
                    if (extractedPath) {
                        sourceToUse = extractedPath;
                    } else {
                        // Fallback: use the existing (potentially modified) level file
                        logger.warn('Could not extract source.copy, using existing level file', {
                            fileId: file.id
                        });
                    }
                }
            }

            // Parse from the source file
            const levelData = new LevelDict(sourceToUse);
            
            // Write the processed version back to the target level path
            levelData.writeToFile(levelPath);
            
            // Update targetSafeToParse flag AND version in metadata
            await file.update({ 
                metadata: { 
                    ...fileMetadata, 
                    targetSafeToParse: true,
                    targetSafeToParseVersion: SAFE_TO_PARSE_VERSION
                } 
            });

            logger.debug('Level file loaded and version updated', {
                fileId: file.id,
                version: SAFE_TO_PARSE_VERSION,
                sourceUsed: sourceToUse
            });

            return { levelData, wasReparsed: true };
        } else {
            // Safe to parse and version is current - use the cached processed file
            const levelData = LevelDict.fromJSON(fs.readFileSync(levelPath, 'utf8'));
            return { levelData, wasReparsed: false };
        }
    }

    /**
     * Parse cache data from string
     */
    parseCacheData(cacheDataString: string | null): LevelCacheData | null {
        if (!cacheDataString) {
            return null;
        }

        try {
            return JSON.parse(cacheDataString);
        } catch (error) {
            logger.error('Failed to parse cache data:', error);
            return null;
        }
    }

    /**
     * Check which requested modes are available in cache
     */
    checkCacheHits(cacheData: LevelCacheData | null, requestedModes: string[]): CacheHitResult {
        const hits: CacheHitResult = {
            tilecount: false,
            settings: false,
            analysis: false,
            accessCount: true // accessCount is always available from file record
        };

        // In development, always treat cache as empty
        if (!cacheData || process.env.NODE_ENV === 'development') {
            return hits;
        }

        for (const mode of requestedModes) {
            if (mode === 'tilecount' && cacheData.tilecount !== undefined) {
                hits.tilecount = true;
            }
            if (mode === 'settings' && cacheData.settings !== undefined) {
                hits.settings = true;
            }
            if (mode === 'analysis' && cacheData.analysis !== undefined) {
                hits.analysis = true;
            }
        }

        return hits;
    }

    /**
     * Populate cache for a level file
     * @param file - CdnFile instance
     * @param levelPath - Path to the level file
     * @param metadata - Optional metadata object to update
     * @param requestedModes - Optional array of requested modes (to compute analysis only if needed)
     * @param levelData - Optional pre-loaded LevelDict to avoid re-parsing
     * @returns Updated cache data
     */
    async populateCache(
        file: CdnFile, 
        levelPath: string, 
        metadata?: any, 
        requestedModes?: string[],
        levelData?: LevelDict
    ): Promise<LevelCacheData> {
        try {
            logger.debug('Populating cache for file:', { fileId: file.id, levelPath, requestedModes });

            const fileMetadata = metadata || file.metadata as any;
            const versionCurrent = this.isVersionCurrent(fileMetadata);

            // Parse existing cache to preserve any existing data
            // BUT invalidate cache if version is outdated (cached data may be incorrect)
            let existingCache = this.parseCacheData(file.cacheData);
            if (process.env.NODE_ENV === 'development' || !versionCurrent) {
                existingCache = null;
                if (!versionCurrent && file.cacheData) {
                    logger.debug('Invalidating cached data due to version mismatch', {
                        fileId: file.id,
                        storedVersion: fileMetadata?.targetSafeToParseVersion,
                        currentVersion: SAFE_TO_PARSE_VERSION
                    });
                }
            }
            
            // Check if file exists
            if (!fs.existsSync(levelPath)) {
                throw new Error(`Level file not found at path: ${levelPath}`);
            }
            
            // Use provided levelData or load it using the unified method
            let parsedLevelData: LevelDict;
            if (levelData) {
                parsedLevelData = levelData;
            } else {
                const result = await this.loadLevelData(file, levelPath, metadata);
                parsedLevelData = result.levelData;
            }

            // Build cache data, preserving existing values
            const cacheData: LevelCacheData = {
                tilecount: existingCache?.tilecount ?? parsedLevelData.getAngles().length,
                settings: existingCache?.settings ?? parsedLevelData.getSettings(),
                analysis: existingCache?.analysis
            };

            // Only compute analysis if explicitly requested in requestedModes and not already cached
            const needsAnalysis = requestedModes?.includes('analysis') && !cacheData.analysis;
            if (needsAnalysis) {
                cacheData.analysis = {
                    containsDLC: analysisUtils.containsDLC(parsedLevelData),
                    dlcEvents: analysisUtils.getDLCEvents(parsedLevelData),
                    canDecorationsKill: analysisUtils.canDecorationsKill(parsedLevelData),
                    isJudgementLimited: analysisUtils.isJudgementLimited(parsedLevelData),
                    levelLengthInMs: analysisUtils.getLevelLengthInMs(parsedLevelData),
                    vfxTier: analysisUtils.getVfxTier(parsedLevelData),
                    requiredMods: analysisUtils.getRequiredMods(parsedLevelData)
                };
            }
            logger.debug('dlc events', {dlcEvents: analysisUtils.getDLCEvents(parsedLevelData)});

            // Update cache in database
            await file.update({ cacheData: JSON.stringify(cacheData) });

            logger.debug('Cache populated successfully:', {
                fileId: file.id,
                tilecount: cacheData.tilecount,
                hasSettings: !!cacheData.settings,
                hasAnalysis: !!cacheData.analysis
            });

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
     * Get cached data with automatic population if missing
     * @param file - CdnFile instance
     * @param levelPath - Path to the level file
     * @param requestedModes - Array of requested data modes
     * @param metadata - Optional metadata object
     * @param levelData - Optional pre-loaded LevelDict to avoid re-parsing
     * @returns Cache data and whether it was populated
     */
    async getCacheWithPopulation(
        file: CdnFile,
        levelPath: string,
        requestedModes: string[],
        metadata?: any,
        levelData?: LevelDict
    ): Promise<{ cacheData: LevelCacheData; wasPopulated: boolean }> {
        // Parse existing cache
        let cacheData = this.parseCacheData(file.cacheData);
        
        // Check version - if outdated, we need to repopulate
        const fileMetadata = metadata || file.metadata as any;
        const versionCurrent = this.isVersionCurrent(fileMetadata);
        
        // Check if cache needs population
        const cacheHits = this.checkCacheHits(cacheData, requestedModes);
        const needsPopulation = requestedModes.some(mode => 
            (mode === 'settings' && !cacheHits.settings) ||
            (mode === 'tilecount' && !cacheHits.tilecount) ||
            (mode === 'analysis' && !cacheHits.analysis)
        );

        if (needsPopulation || !cacheData || !versionCurrent || process.env.NODE_ENV === 'development') {
            // Populate cache (will also handle version update and cache invalidation)
            cacheData = await this.populateCache(file, levelPath, metadata, requestedModes, levelData);
            return { cacheData, wasPopulated: true };
        }

        return { cacheData, wasPopulated: false };
    }

    /**
     * Ensure cache is up-to-date for a file
     * Populates cache if missing or incomplete
     * @param fileId - File UUID
     * @returns Cache data or null if failed
     */
    async ensureCachePopulated(fileId: string): Promise<LevelCacheData | null> {
        try {
            const file = await CdnFile.findByPk(fileId);
            if (!file) {
                logger.error('File not found:', { fileId });
                return null;
            }

            if (file.type !== 'LEVELZIP') {
                logger.error('File is not a level zip:', { fileId, type: file.type });
                return null;
            }

            const metadata = file.metadata as {
                allLevelFiles?: Array<{
                    name: string;
                    path: string;
                    size: number;
                }>;
                targetLevel?: string | null;
            };

            if (!metadata.allLevelFiles || metadata.allLevelFiles.length === 0) {
                logger.error('No level files found in metadata:', { fileId });
                return null;
            }

            // Determine target level
            const targetLevel = metadata.targetLevel || metadata.allLevelFiles[0].path;
            
            if (!fs.existsSync(targetLevel)) {
                logger.error('Target level file not found:', { fileId, targetLevel });
                return null;
            }

            // In development, always repopulate cache
            if (process.env.NODE_ENV === 'development') {
                return await this.populateCache(file, targetLevel, metadata);
            }

            // Check if cache needs population or version is outdated
            const cacheData = this.parseCacheData(file.cacheData);
            const versionCurrent = this.isVersionCurrent(metadata);
            
            if (!cacheData || cacheData.tilecount === undefined || cacheData.settings === undefined || !versionCurrent) {
                // Populate cache (will also update version if outdated)
                return await this.populateCache(file, targetLevel, metadata);
            }

            return cacheData;
        } catch (error) {
            logger.error('Failed to ensure cache populated:', {
                fileId,
                error: error instanceof Error ? error.message : String(error)
            });
            return null;
        }
    }

    /**
     * Get cache data for specific modes without automatic population
     * @param file - CdnFile instance
     * @param requestedModes - Array of requested data modes
     * @returns Partial response object with available cached data
     */
    getCachedDataForModes(
        file: CdnFile,
        requestedModes: string[]
    ): Partial<{
        tilecount: number;
        settings: any;
        analysis: {
            containsDLC?: boolean;
            canDecorationsKill?: boolean;
            isJudgementLimited?: boolean;
            levelLengthInMs?: number;
            vfxTier?: constants.VfxTier;
            requiredMods?: string[];
        };
        accessCount: number;
    }> {
        const response: Partial<{
            tilecount: number;
            settings: any;
            analysis: {
                containsDLC?: boolean;
                canDecorationsKill?: boolean;
                isJudgementLimited?: boolean;
                levelLengthInMs?: number;
                vfxTier?: constants.VfxTier;
                requiredMods?: string[];
            };
            accessCount: number;
        }> = {};

        // In development, always return empty cache to force recalculation
        if (process.env.NODE_ENV === 'development') {
            // Only return accessCount as it's not cached
            if (requestedModes.includes('accessCount')) {
                response.accessCount = file.accessCount || 0;
            }
            return response;
        }

        const cacheData = this.parseCacheData(file.cacheData);
        const cacheHits = this.checkCacheHits(cacheData, requestedModes);

        if (requestedModes.includes('tilecount') && cacheHits.tilecount && cacheData) {
            response.tilecount = cacheData.tilecount;
        }

        if (requestedModes.includes('settings') && cacheHits.settings && cacheData) {
            response.settings = cacheData.settings;
        }

        if (requestedModes.includes('analysis') && cacheHits.analysis && cacheData?.analysis) {
            response.analysis = cacheData.analysis;
        }

        if (requestedModes.includes('accessCount')) {
            response.accessCount = file.accessCount || 0;
        }

        return response;
    }
}

export const levelCacheService = LevelCacheService.getInstance();

