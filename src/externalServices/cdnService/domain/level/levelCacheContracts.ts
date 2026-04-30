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
export const REQUIRED_ANALYSIS_KEYS = [
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

export interface AnalysisCacheData {
    _version: number;
    containsDLC?: boolean;
    dlcEvents?: string[];
    autoTile?: boolean;
    canDecorationsKill?: boolean;
    isJudgementLimited?: boolean;
    levelLengthInMs?: number;
    nonGameplayEventCounts?: { [key: string]: number; total: number };
    vfxEventCounts?: { [key: string]: number; total: number };
    decoEventCounts?: { [key: string]: number; total: number };
    requiredMods?: string[];
}

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

