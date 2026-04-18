import { logger } from '@/server/services/core/LoggerService.js';
import CdnFile from '@/models/cdn/CdnFile.js';
import LevelDict, { analysisUtils } from 'adofai-lib';
import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import dotenv from 'dotenv';
import { spacesStorage } from './spacesStorage.js';
import { CdnSpacesTempDomain, withCdnFileDomainWorkspace } from './cdnSpacesTemp.js';
import { PROTECTED_EVENT_TYPES } from './levelTransformer.js';

dotenv.config();

/**
 * Version number for the safe-to-parse flag.
 * Increment this when breaking changes are made to the level parsing logic
 * to force re-parsing of all cached levels.
 */
export const SAFE_TO_PARSE_VERSION = 3;

/**
 * Version number for the analysis cache format.
 * Increment this when:
 * - New fields are added to analysis
 * - Field types or meanings change
 * - Calculation logic for any analysis field changes
 *
 * This invalidates ONLY the analysis cache, not tilecount/settings.
 */
export const ANALYSIS_FORMAT_VERSION = 5;

/**
 * Analysis object keys that must be present on a fully populated cache entry
 * (increment ANALYSIS_FORMAT_VERSION when this set changes).
 */
const REQUIRED_ANALYSIS_KEYS = [
    'containsDLC',
    'dlcEvents',
    'autoTile',
    'canDecorationsKill',
    'isJudgementLimited',
    'levelLengthInMs',
    'nonGameplayEventCounts',
    'vfxEventCounts',
    'decoEventCounts',
    'requiredMods'
] as const;

// Analysis data structure
export interface AnalysisCacheData {
    _version: number; // Format version for invalidation
    containsDLC?: boolean;
    dlcEvents?: string[];
    autoTile?: boolean;
    canDecorationsKill?: boolean;
    isJudgementLimited?: boolean;
    levelLengthInMs?: number;
    nonGameplayEventCounts?: { [key: string]: number, total: number };
    vfxEventCounts?: { [key: string]: number, total: number };
    decoEventCounts?: { [key: string]: number, total: number };
    requiredMods?: string[];
}

// Cache data structure
export interface LevelCacheData {
    _metadataSignature?: string;
    tilecount?: number;
    settings?: any;
    analysis?: AnalysisCacheData;
    transformOptions?: {
        eventTypes: string[];
        filterTypes: string[];
        advancedFilterTypes: string[];
    };
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
     * Stable signature for metadata fields that affect level cache semantics.
     * Extend the picked object when new metadata drives parse/cache behavior.
     */
    private computeCacheMetadataSignature(metadata: any): string {
        const relevant = {
            targetLevel: metadata?.targetLevel ?? null,
            targetLevelOversized: metadata?.targetLevelOversized ?? false,
            targetSafeToParse: metadata?.targetSafeToParse ?? false,
            targetSafeToParseVersion: metadata?.targetSafeToParseVersion
        };
        return JSON.stringify(relevant, Object.keys(relevant).sort());
    }

    private analysisHasExpectedShape(analysis: AnalysisCacheData | undefined): boolean {
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
    private isLevelCacheFullyValid(cacheData: LevelCacheData, metadata: any): boolean {
        if (!this.isVersionCurrent(metadata)) {
            return false;
        }
        if (cacheData._metadataSignature !== this.computeCacheMetadataSignature(metadata)) {
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
        return this.analysisHasExpectedShape(cacheData.analysis);
    }

    private getTargetLevelMetadataEntry(metadata: any, targetLevelPath: string): any | null {
        const allLevelFiles = metadata?.allLevelFiles || [];
        const normalizedTargetPath = String(targetLevelPath).replace(/\\/g, '/').replace(/^\/+/, '');
        for (const levelFile of allLevelFiles) {
            const filePath = String(levelFile?.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
            const relativePath = String(levelFile?.relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
            if (filePath === normalizedTargetPath || relativePath === normalizedTargetPath) {
                return levelFile;
            }
        }
        return null;
    }

    private async resolveReadableLevelPath(
        file: CdnFile,
        levelPath: string,
        join: (...parts: string[]) => string
    ): Promise<{ localPath: string }> {
        const levelExists = await spacesStorage.fileExists(levelPath);
        if (!levelExists) {
            throw new Error(`Target level file not found in storage: ${levelPath}`);
        }

        const ext = path.extname(levelPath) || '.adofai';
        const tempPath = join(`level_${Date.now()}${ext}`);
        await spacesStorage.downloadFileToPathStreaming(levelPath, tempPath);

        return { localPath: tempPath };
    }

    /**
     * Download original .adofai bytes from Spaces (stored copy or zip) into the current workspace.
     */
    private async extractSourceCopy(
        file: CdnFile,
        targetLevelPath: string,
        metadata: any,
        join: (...parts: string[]) => string
    ): Promise<{ localPath: string } | null> {
        try {
            const targetLevelEntry = this.getTargetLevelMetadataEntry(metadata, targetLevelPath);

            if (targetLevelEntry?.sourceCopyPath) {
                const sourceCheck = await spacesStorage.fileExists(targetLevelEntry.sourceCopyPath);
                if (!sourceCheck) {
                    throw new Error(`Source copy file not found in storage: ${targetLevelEntry.sourceCopyPath}`);
                }

                const ext = path.extname(String(targetLevelEntry.sourceCopyPath)) || '.adofai';
                const targetCopyPath = join(`source_copy${ext}`);
                await spacesStorage.downloadFileToPathStreaming(targetLevelEntry.sourceCopyPath, targetCopyPath);
                return { localPath: targetCopyPath };
            }

            const originalZip = metadata?.originalZip;
            if (!originalZip?.path) {
                logger.warn('No original zip path in metadata, cannot extract source copy', {
                    fileId: file.id
                });
                return null;
            }

            const tempZipPath = join(`original_${Date.now()}.zip`);

            logger.debug('Downloading zip for source copy extraction', {
                fileId: file.id,
                zipPath: originalZip.path,
                tempZipPath
            });

            await spacesStorage.downloadFileToPathStreaming(originalZip.path, tempZipPath);

            const levelEntry = targetLevelEntry || this.getTargetLevelMetadataEntry(metadata, targetLevelPath);
            const targetLevelName: string = levelEntry?.name || path.basename(targetLevelPath);
            const targetRelativePath: string | null = levelEntry?.relativePath
                ? String(levelEntry.relativePath).replace(/\\/g, '/').replace(/^\/+/, '')
                : null;

            try {
                const zip = new AdmZip(tempZipPath);
                const entries = zip.getEntries();

                let foundEntry: AdmZip.IZipEntry | null = null;
                if (targetRelativePath) {
                    foundEntry = entries.find(entry =>
                        entry.entryName.replace(/\\/g, '/').replace(/^\/+/, '') === targetRelativePath
                    ) || null;
                }
                if (!foundEntry) {
                    for (const entry of entries) {
                        if (entry.name === targetLevelName || entry.entryName.endsWith(targetLevelName)) {
                            foundEntry = entry;
                            break;
                        }
                    }
                }

                if (!foundEntry) {
                    logger.warn('Target level file not found in zip', {
                        fileId: file.id,
                        targetLevelName,
                        availableEntries: entries.map(e => e.name)
                    });
                    return null;
                }

                const originalContent = foundEntry.getData();
                const extractedPath = join(`extracted_${Date.now()}.adofai`);
                await fs.promises.writeFile(extractedPath, originalContent);

                logger.debug('Source copy extracted successfully', {
                    fileId: file.id,
                    extractedPath,
                    size: originalContent.length
                });

                return { localPath: extractedPath };
            } finally {
                await fs.promises.unlink(tempZipPath).catch(() => Promise.resolve());
            }
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

        if (fileMetadata?.targetLevelOversized) {
            throw new Error('Level file is too large to parse (oversized); cache and level data are not available');
        }

        return withCdnFileDomainWorkspace(
            CdnSpacesTempDomain.LevelCache,
            file.id,
            async ({ join }) => {
                const resolvedLevel = await this.resolveReadableLevelPath(file, levelPath, join);

                const safeToParse = fileMetadata?.targetSafeToParse || false;
                const versionCurrent = this.isVersionCurrent(fileMetadata);

                const needsReparse = !safeToParse || !versionCurrent;

                if (needsReparse) {
                    let sourceToUse = resolvedLevel.localPath;

                    if (safeToParse && !versionCurrent) {
                        logger.debug('SafeToParse version outdated, extracting original source', {
                            fileId: file.id,
                            storedVersion: fileMetadata?.targetSafeToParseVersion,
                            currentVersion: SAFE_TO_PARSE_VERSION
                        });

                        const extracted = await this.extractSourceCopy(file, levelPath, fileMetadata, join);
                        if (extracted) {
                            sourceToUse = extracted.localPath;
                        } else {
                            logger.warn('Could not extract original source from Spaces, using downloaded level file', {
                                fileId: file.id
                            });
                        }
                    }

                    const levelData = new LevelDict(sourceToUse);

                    levelData.writeToFile(resolvedLevel.localPath);

                    await spacesStorage.uploadFile(resolvedLevel.localPath, levelPath, 'application/json');

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
                }

                const raw = await fs.promises.readFile(resolvedLevel.localPath, 'utf8');
                const levelData = LevelDict.fromJSON(raw);
                return { levelData, wasReparsed: false };
            }
        );
    }

    /**
     * Deserialize DB `cacheData` JSON and apply safe-to-parse / dev invalidation.
     */
    private parseStoredCacheJson(cacheDataString: string | null, metadata?: any): LevelCacheData | null {
        //if (process.env.NODE_ENV === 'development') return null;

        if (!cacheDataString) {
            return null;
        }

        if (metadata !== undefined && !this.isVersionCurrent(metadata)) {
            logger.debug('Cache invalidated due to version mismatch', {
                storedVersion: metadata?.targetSafeToParseVersion,
                currentVersion: SAFE_TO_PARSE_VERSION
            });
            return null;
        }

        try {
            return JSON.parse(cacheDataString) as LevelCacheData;
        } catch (error) {
            logger.error('Failed to parse cache data:', error);
            return null;
        }
    }

    private buildFullAnalysis(parsedLevelData: LevelDict): AnalysisCacheData {
        const eventCounts = analysisUtils.getEventCounts(parsedLevelData);
        const nonGameplayEventCounts = Object.keys(eventCounts).filter(event => !PROTECTED_EVENT_TYPES.has(event)).reduce((acc: { [key: string]: number, total: number }, event: string) => {
            acc[event] = eventCounts[event] || 0;
            return acc;
        }, { total: 0 });
        nonGameplayEventCounts.total = Object.values(nonGameplayEventCounts).reduce((acc, count) => acc + count, 0);

        return {
            _version: ANALYSIS_FORMAT_VERSION,
            containsDLC: analysisUtils.containsDLC(parsedLevelData),
            dlcEvents: analysisUtils.getDLCEvents(parsedLevelData),
            autoTile: parsedLevelData.getTiles().some(tile => tile.actions.some(action => action.eventType === 'AutoPlayTiles')),
            canDecorationsKill: analysisUtils.canDecorationsKill(parsedLevelData),
            isJudgementLimited: analysisUtils.isJudgementLimited(parsedLevelData),
            levelLengthInMs: analysisUtils.getLevelLengthInMs(parsedLevelData),
            vfxEventCounts: analysisUtils.getVfxEventCounts(parsedLevelData),
            decoEventCounts: analysisUtils.getDecoEventCounts(parsedLevelData),
            requiredMods: analysisUtils.getRequiredMods(parsedLevelData),
            nonGameplayEventCounts
        };
    }

    private buildTransformOptions(parsedLevelData: LevelDict): {
        eventTypes: string[];
        filterTypes: string[];
        advancedFilterTypes: string[];
    } {
        const eventTypes = new Set<string>();
        const filterTypes = new Set<string>();
        const advancedFilterTypes = new Set<string>();

        const actions = parsedLevelData.getActions();
        for (const action of actions) {
            const eventType = action.eventType || '';
            if (PROTECTED_EVENT_TYPES.has(eventType)) {
                continue;
            }

            if (eventType) {
                eventTypes.add(eventType);
            }

            if (eventType === 'SetFilter' && action.filter) {
                filterTypes.add(action.filter);
            } else if (eventType === 'SetFilterAdvanced' && action.filter) {
                advancedFilterTypes.add(action.filter);
            }
        }

        return {
            eventTypes: Array.from(eventTypes).sort(),
            filterTypes: Array.from(filterTypes).sort(),
            advancedFilterTypes: Array.from(advancedFilterTypes).sort()
        };
    }

    private async buildAndPersistFullCache(
        file: CdnFile,
        levelPath: string,
        metadata: any,
        parsedLevelData: LevelDict
    ): Promise<LevelCacheData> {
        const cacheData: LevelCacheData = {
            _metadataSignature: this.computeCacheMetadataSignature(metadata),
            tilecount: parsedLevelData.getAngles().length,
            settings: parsedLevelData.getSettings(),
            analysis: this.buildFullAnalysis(parsedLevelData),
            transformOptions: this.buildTransformOptions(parsedLevelData)
        };

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
        if (parsed && this.isLevelCacheFullyValid(parsed, fileMetadata)) {
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
     * Ensure cache is up-to-date for a file
     * Populates cache if missing or incomplete
     * @param fileId - File UUID
     * @returns Cache data or null if failed
     */
    async ensureCachePopulated(fileId: string): Promise<LevelCacheData | null> {
        try {
            const file = await CdnFile.findByPk(fileId);
            if (!file) {
                logger.debug('ensureCachePopulated: file not found', { fileId });
                return null;
            }

            if (file.type !== 'LEVELZIP') {
                logger.debug('ensureCachePopulated: not a level zip', { fileId, type: file.type });
                return null;
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

            if (!metadata.allLevelFiles || metadata.allLevelFiles.length === 0) {
                logger.debug('ensureCachePopulated: no level files in metadata', { fileId });
                return null;
            }

            if (metadata.targetLevelOversized) {
                logger.debug('Skipping cache population for oversized level (not parsed)', { fileId });
                return null;
            }

            // Determine target level
            const targetLevel = metadata.targetLevel || metadata.allLevelFiles[0].path;

            const levelCheck = await spacesStorage.fileExists(targetLevel);
            if (!levelCheck) {
                logger.debug('ensureCachePopulated: target level not in storage', { fileId, targetLevel });
                return null;
            }

            const { cacheData } = await this.getLevelCache(file, targetLevel, metadata);
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

