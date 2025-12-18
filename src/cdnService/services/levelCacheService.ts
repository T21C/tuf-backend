import { logger } from '../../services/LoggerService.js';
import CdnFile from '../../models/cdn/CdnFile.js';
import LevelDict, { analysisUtils, constants } from 'adofai-lib';
import fs from 'fs';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

// Cache data structure
export interface LevelCacheData {
    tilecount?: number;
    settings?: any;
    analysis?: {
        containsDLC?: boolean;
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

        if (!cacheData) {
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

            // Parse existing cache to preserve any existing data
            let existingCache = this.parseCacheData(file.cacheData);
            if (process.env.NODE_ENV === 'development') {
                existingCache = null;
            }
            
            // Check if file exists
            if (!fs.existsSync(levelPath)) {
                throw new Error(`Level file not found at path: ${levelPath}`);
            }

            // Parse the level file if not provided
            const fileMetadata = metadata || file.metadata as any;
            const safeToParse = fileMetadata?.targetSafeToParse || false;
            let parsedLevelData: LevelDict;

            if (levelData) {
                parsedLevelData = levelData;
            } else {
                if (!safeToParse) {
                    parsedLevelData = new LevelDict(levelPath);
                    parsedLevelData.writeToFile(levelPath);
                    
                    // Update targetSafeToParse flag in metadata
                    await file.update({ 
                        metadata: { 
                            ...fileMetadata, 
                            targetSafeToParse: true 
                        } 
                    });
                } else {
                    parsedLevelData = LevelDict.fromJSON(fs.readFileSync(levelPath, 'utf8'));
                }
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
                    canDecorationsKill: analysisUtils.canDecorationsKill(parsedLevelData),
                    isJudgementLimited: analysisUtils.isJudgementLimited(parsedLevelData),
                    levelLengthInMs: analysisUtils.getLevelLengthInMs(parsedLevelData),
                    vfxTier: analysisUtils.getVfxTier(parsedLevelData),
                    requiredMods: analysisUtils.getRequiredMods(parsedLevelData)
                };
            }

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
        
        // Check if cache needs population
        const cacheHits = this.checkCacheHits(cacheData, requestedModes);
        const needsPopulation = requestedModes.some(mode => 
            (mode === 'settings' && !cacheHits.settings) ||
            (mode === 'tilecount' && !cacheHits.tilecount) ||
            (mode === 'analysis' && !cacheHits.analysis)
        );

        if (needsPopulation || !cacheData) {
            // Populate cache
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

            // Check if cache needs population
            const cacheData = this.parseCacheData(file.cacheData);
            
            if (!cacheData || cacheData.tilecount === undefined || cacheData.settings === undefined) {
                // Populate cache
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

