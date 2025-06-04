import { logger } from '../../services/LoggerService.js';

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
]);

/* -----------------------------------------------------------
 * TYPES
 * ---------------------------------------------------------*/
export interface LevelJSON {
    actions?: Array<Record<string, any>>;
    decorations?: Array<Record<string, any>>;
    [key: string]: any;
}

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
     * Remove decoration items for which this predicate returns `true`.  
     * Useful for things like `decorationImage.endsWith('.txt')` etc.
     */
    decorationFilter?: (deco: Record<string, any>) => boolean;

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
export function transformLevel(level: LevelJSON, options: TransformOptions = {}): LevelJSON {
    const {
        keepEventTypes,
        dropEventTypes,
        decorationFilter,
        baseCameraZoom = 1,
        extraProtectedEventTypes = new Set<string>(),
        additionalPatterns = new Set<RegExp>()
    } = options;

    // Create a copy so we never mutate caller data
    const cloned: LevelJSON = JSON.parse(JSON.stringify(level));

    /* --------------------
     *  ACTIONS / EVENTS
     * ------------------*/
    if (Array.isArray(cloned.actions)) {
        cloned.actions = cloned.actions.filter((act) => {
            const type: string | undefined = act?.eventType;
            if (!type) return true; // guard – malformed but we keep it

            // Always keep protected events
            if (PROTECTED_EVENT_TYPES.has(type) || extraProtectedEventTypes.has(type)) {
                return true;
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
        }).map((act) => {
            // -------- zoom multiplier --------
            if (baseCameraZoom !== 1 && act?.eventType === 'MoveCamera') {
                if (isNumber(act.zoom)) {
                    act.zoom = act.zoom * baseCameraZoom;
                }
            }
            return act;
        });
    }

    /* --------------------
     *  DECORATIONS
     * ------------------*/
    if (Array.isArray(cloned.decorations) && decorationFilter) {
        cloned.decorations = cloned.decorations.filter((deco) => !decorationFilter(deco));
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
            Array.from(additionalPatterns).map(p => p.toString()) : undefined
    });

    return cloned;
} 