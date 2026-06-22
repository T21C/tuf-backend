import type { Action, LevelJSON } from 'adofai-lib';

export const V3_VERSION = 18;
export const V2_VERSION = 15;

/**
 * Downgrade a v3+ level JSON to a v2-compatible format:
 * - settings.version -> 15
 * - SetFilterAdvanced.filterProperties -> inlined string (no outer braces/brackets)
 */
export function convertV3ToV2(level: LevelJSON): LevelJSON {
    const out: LevelJSON = {
        ...level,
        settings: { ...level.settings },
        actions: (level.actions ?? []).map((action: Action) => {
            if (action.eventType !== 'SetFilterAdvanced') {
                return action;
            }
            return {
                ...action,
                filterProperties: JSON.stringify(action.filterProperties).slice(1, -1)
            };
        })
    };

    if (out.settings) {
        out.settings.version = V2_VERSION;
    }

    return out;
}
