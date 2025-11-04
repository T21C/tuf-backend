import { logger } from '../../services/LoggerService.js';
import CdnFile from '../../models/cdn/CdnFile.js';
import LevelDict from 'adofai-lib';
import fs from 'fs';
import path from 'path';

// Cache data structure
export interface LevelCacheData {
    tilecount?: number;
    settings?: any;
}

// Cache hit result for checking what data is available
export interface CacheHitResult {
    tilecount: boolean;
    settings: boolean;
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
        }

        return hits;
    }

    /**
     * Populate cache for a level file
     * @param file - CdnFile instance
     * @param levelPath - Path to the level file
     * @param metadata - Optional metadata object to update
     * @returns Updated cache data
     */
    async populateCache(file: CdnFile, levelPath: string, metadata?: any): Promise<LevelCacheData> {
        try {
            logger.debug('Populating cache for file:', { fileId: file.id, levelPath });

            // Check if file exists
            if (!fs.existsSync(levelPath)) {
                throw new Error(`Level file not found at path: ${levelPath}`);
            }

            // Parse the level file
            const fileMetadata = metadata || file.metadata as any;
            const safeToParse = fileMetadata?.targetSafeToParse || false;
            let levelData: LevelDict;

            if (!safeToParse) {
                levelData = new LevelDict(levelPath);
                levelData.writeToFile(levelPath);
                
                // Update targetSafeToParse flag in metadata
                await file.update({ 
                    metadata: { 
                        ...fileMetadata, 
                        targetSafeToParse: true 
                    } 
                });
            } else {
                levelData = LevelDict.fromJSON(fs.readFileSync(levelPath, 'utf8'));
            }

            // Build cache data
            const cacheData: LevelCacheData = {
                tilecount: levelData.getAngles().length,
                settings: levelData.getSettings()
            };

            // Update cache in database
            await file.update({ cacheData: JSON.stringify(cacheData) });

            logger.debug('Cache populated successfully:', {
                fileId: file.id,
                tilecount: cacheData.tilecount,
                hasSettings: !!cacheData.settings
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
     * @returns Cache data and whether it was populated
     */
    async getCacheWithPopulation(
        file: CdnFile,
        levelPath: string,
        requestedModes: string[],
        metadata?: any
    ): Promise<{ cacheData: LevelCacheData; wasPopulated: boolean }> {
        // Parse existing cache
        let cacheData = this.parseCacheData(file.cacheData);
        
        // Check if cache needs population
        const cacheHits = this.checkCacheHits(cacheData, requestedModes);
        const needsPopulation = requestedModes.some(mode => 
            (mode === 'settings' && !cacheHits.settings) ||
            (mode === 'tilecount' && !cacheHits.tilecount)
        );

        if (needsPopulation || !cacheData) {
            // Populate cache
            cacheData = await this.populateCache(file, levelPath, metadata);
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
        accessCount: number;
    }> {
        const response: Partial<{
            tilecount: number;
            settings: any;
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

        if (requestedModes.includes('accessCount')) {
            response.accessCount = file.accessCount || 0;
        }

        return response;
    }
}

export const levelCacheService = LevelCacheService.getInstance();

