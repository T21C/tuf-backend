import { logger } from '../../../server/services/LoggerService.js';
import LevelDict, { Action } from 'adofai-lib';

/**
 * List of core gameplay events that MUST NEVER be removed from a level file.
 * If the game introduces new core-events simply extend this array when calling
 * `transformLevel` via the `extraProtectedEventTypes` option.
 */
export const PROTECTED_EVENT_TYPES: ReadonlySet<string> = new Set([
    //   --- Timing / path altering events ---
    'SetSpeed',
    'Twirl',
    'Pause',
    'Hold',
    'MultiPlanet',
    'FreeRoam',
    'FreeRoamRemove',
    'FreeRoamTwirl',
    'Hide',
    'ScaleMargin',
    'SetPlanetRotation',
    'AutoPlayTiles'
    // safeguard — extend from frontend if needed
]);


/**
 * Regex patterns for event types that will be removed.
 * These patterns are matched against event types to remove groups of related events.
 */
export const ALWAYS_REMOVE_EVENTS: ReadonlySet<RegExp> = new Set([
    // Remove all decoration-related events
    /.*Decoration.*/,
    // Remove all text-related events
    /.*Text.*/,
    // Remove all particle-related events
    /.*Particle.*/,

    /.*Object.*/,
]);

/* -----------------------------------------------------------
 * TYPES
 * ---------------------------------------------------------*/

export interface TransformOptions {
    /**
     * Keep only these event types (besides protected ones).
     * If undefined – all event types are kept unless they appear in `dropEventTypes`.
     */
    keepEventTypes?: Set<string>;

    /**
     * Remove these event types.
     * Ignored for any type present in `PROTECTED_EVENT_TYPES` or `extraProtectedEventTypes`.
     */
    dropEventTypes?: Set<string>;

    /**
     * Multiply every `MoveCamera` / zoom-like event by this factor.
     * Defaults to `1` (no change).
     */
    baseCameraZoom?: number;

    /**
     * Additional gameplay event types that must be kept intact.
     */
    extraProtectedEventTypes?: Set<string>;

    /**
     * Additional regex patterns to match against event types.
     * Events matching these patterns will be removed.
     */
    additionalPatterns?: Set<RegExp>;

    /**
     * Set a constant background color and remove all background flash events.
     * Format: #rrggbbaa (hex color with alpha)
     */
    constantBackgroundColor?: string;

    /**
     * Remove all flash events that have their plane set to "Foreground"
     */
    removeForegroundFlash?: boolean;

    /**
     * Remove filter events that have their filter field matching any of these values.
     * Applies to both SetFilter and SetFilterAdvanced events.
     */
    dropFilters?: Set<string>;
}

const isNumber = (val: any): val is number => typeof val === 'number' && !isNaN(val);

/**
 * Check if an event type matches any of the given patterns
 */
function matchesPatterns(type: string, patterns: ReadonlySet<RegExp>): boolean {
    return Array.from(patterns).some(pattern => pattern.test(type));
}

/* -----------------------------------------------------------
 * CORE TRANSFORMER
 * ---------------------------------------------------------*/
export function transformLevel(level: LevelDict, options: TransformOptions = {}): LevelDict {
    const {
        keepEventTypes,
        dropEventTypes,
        baseCameraZoom = 1,
        extraProtectedEventTypes = new Set<string>(),
        additionalPatterns = new Set<RegExp>(),
        constantBackgroundColor,
        removeForegroundFlash,
        dropFilters
    } = options;

    // Create a copy so we never mutate caller data
    const cloned = level.copy();

    /* --------------------
     *  ACTIONS / EVENTS
     * ------------------*/
    // Get all actions and filter them
    const filteredActions = level.getActions().filter((act: Action) => {
        const type: string | undefined = act?.eventType;
        if (!type) return true; // guard – malformed but we keep it

        // Always keep protected events
        if (PROTECTED_EVENT_TYPES.has(type) || extraProtectedEventTypes.has(type)) {
            return true;
        }

        // Remove background flash events if constantBackgroundColor is set
        if (constantBackgroundColor && type === 'Flash' && act.plane === 'Background') {
            return false;
        }

        // Remove foreground flash events if removeForegroundFlash is true
        if (removeForegroundFlash && type === 'Flash' && act.plane === 'Foreground') {
            return false;
        }

        // Remove filter events if their filter matches any in dropFilters
        if (dropFilters && (type === 'SetFilter' || type === 'SetFilterAdvanced') && act.filter) {
            if (dropFilters.has(act.filter)) {
                return false;
            }
        }

        // Check against all patterns (built-in and additional)
        if (matchesPatterns(type, ALWAYS_REMOVE_EVENTS) || matchesPatterns(type, additionalPatterns)) {
            return false;
        }

        // If keepEventTypes specified – discard everything not in the set
        if (keepEventTypes) {
            return keepEventTypes.has(type);
        }

        // Else if dropEventTypes specified – discard those in the set
        if (dropEventTypes) {
            return !dropEventTypes.has(type);
        }

        // Otherwise keep everything
        return true;
    }).map((act: Action) => {
        // -------- zoom multiplier --------
        if (baseCameraZoom !== 1 && act?.eventType === 'MoveCamera') {
            if (isNumber(act.zoom)) {
                act.zoom = act.zoom * baseCameraZoom;
            }
        }
        return act;
    });

    // Set the filtered actions back to the level
    cloned.setActions(filteredActions);

    // Handle settings
    const settings = cloned.toJSON().settings;
    if (settings) {
        if (constantBackgroundColor) {
            // Extract opacity from the hex color (last 2 digits)
            //const opacity = parseInt(constantBackgroundColor.slice(-2), 16) / 255;
            const color = constantBackgroundColor.slice(0, -2);
            settings.backgroundColor = color;
            settings.bgImage = '';
            settings.showDefaultBGIfNoImage = 'Disabled';
        }
        if (baseCameraZoom !== 1 && typeof settings.zoom === 'number') {
            settings.zoom *= baseCameraZoom;
        }
    }

    // Remove all decorations
    cloned.setDecorations([]);

    // Add constant background color flash if specified
    if (constantBackgroundColor) {
        const flashAction: Action = {
            floor: 0,
            eventType: 'Flash',
            duration: 0,
            plane: 'Background',
            startColor: constantBackgroundColor,
            startOpacity: 100,
            endColor: constantBackgroundColor,
            endOpacity: 100,
            angleOffset: -99999,
            ease: 'Linear',
            eventTag: ''
        };
        cloned.insertAction(0, flashAction);
    }

    /*
     *  Hook for future global transforms can be added here.
     *  Keep the transformer strictly data-agnostic so that the
     *  frontend can drive behaviour solely via options.
     */

    logger.debug('Level transformed with options', {
        keepEventTypes: keepEventTypes ? Array.from(keepEventTypes) : undefined,
        dropEventTypes: dropEventTypes ? Array.from(dropEventTypes) : undefined,
        baseCameraZoom,
        additionalPatterns: additionalPatterns.size > 0 ?
            Array.from(additionalPatterns).map(p => p.toString()) : undefined,
        constantBackgroundColor,
        removeForegroundFlash,
        dropFilters: dropFilters ? Array.from(dropFilters) : undefined
    });

    return cloned;
}
