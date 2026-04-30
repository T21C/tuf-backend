/**
 * Persisted minimal cache for oversized levels (no full LevelDict in DB).
 */
export type OversizedMinimalCache = {
    _metadataSignature?: string;
    tilecount?: number;
    settings?: any;
    analysis?: any;
    transformOptions?: {
        eventTypes: string[];
        filterTypes: string[];
        advancedFilterTypes: string[];
    };
};

/**
 * Subset of {@link CdnFile} metadata needed to validate / rebuild oversized cache.
 */
export type OversizedZipMetadata = {
    allLevelFiles?: Array<{
        name: string;
        path: string;
        size: number;
        relativePath?: string;
    }>;
    targetLevel?: string | null;
    targetLevelRelativePath?: string | null;
    targetLevelOversized?: boolean;
    songFiles?: Record<string, { name: string; path: string; size: number; type: string }>;
    originalZip?: { path?: string };
};
