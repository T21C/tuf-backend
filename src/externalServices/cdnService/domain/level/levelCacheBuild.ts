import type LevelDict from 'adofai-lib';
import { analysisUtils } from 'adofai-lib';
import { computeLevelCacheMetadataSignature } from './levelCacheSignature.js';
import { ANALYSIS_FORMAT_VERSION, type AnalysisCacheData, type LevelCacheData } from './levelCacheContracts.js';

export function buildFullAnalysis(parsedLevelData: LevelDict, protectedEventTypes: ReadonlySet<string>): AnalysisCacheData {
    const eventCounts = analysisUtils.getEventCounts(parsedLevelData);
    const nonGameplayEventCounts = Object.keys(eventCounts)
        .filter((event) => !protectedEventTypes.has(event))
        .reduce(
            (acc: { [key: string]: number; total: number }, event: string) => {
                acc[event] = eventCounts[event] || 0;
                return acc;
            },
            { total: 0 }
        );
    nonGameplayEventCounts.total = Object.values(nonGameplayEventCounts).reduce((acc, count) => acc + count, 0);

    return {
        _version: ANALYSIS_FORMAT_VERSION,
        containsDLC: analysisUtils.containsDLC(parsedLevelData),
        dlcEvents: analysisUtils.getDLCEvents(parsedLevelData),
        autoTile: parsedLevelData.getTiles().some((tile) => tile.actions.some((action) => action.eventType === 'AutoPlayTiles')),
        canDecorationsKill: analysisUtils.canDecorationsKill(parsedLevelData),
        isJudgementLimited: analysisUtils.isJudgementLimited(parsedLevelData),
        levelLengthInMs: analysisUtils.getLevelLengthInMs(parsedLevelData),
        vfxEventCounts: analysisUtils.getVfxEventCounts(parsedLevelData),
        decoEventCounts: analysisUtils.getDecoEventCounts(parsedLevelData),
        requiredMods: analysisUtils.getRequiredMods(parsedLevelData),
        nonGameplayEventCounts
    };
}

export function buildTransformOptions(
    parsedLevelData: LevelDict,
    protectedEventTypes: ReadonlySet<string>
): { eventTypes: string[]; filterTypes: string[]; advancedFilterTypes: string[] } {
    const eventTypes = new Set<string>();
    const filterTypes = new Set<string>();
    const advancedFilterTypes = new Set<string>();

    const actions = parsedLevelData.getActions();
    for (const action of actions) {
        const eventType = action.eventType || '';
        if (protectedEventTypes.has(eventType)) {
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

export function buildFullCachePayload(params: {
    parsedLevelData: LevelDict;
    metadata: any;
    protectedEventTypes: ReadonlySet<string>;
}): LevelCacheData {
    const { parsedLevelData, metadata, protectedEventTypes } = params;

    return {
        _metadataSignature: computeLevelCacheMetadataSignature(metadata),
        tilecount: parsedLevelData.getAngles().length,
        settings: parsedLevelData.getSettings(),
        analysis: buildFullAnalysis(parsedLevelData, protectedEventTypes),
        transformOptions: buildTransformOptions(parsedLevelData, protectedEventTypes)
    };
}

