/**
 * Bump when pass-summary filters, score formulas, or rank cohort rules change.
 * Historical rows stay under prior versions; cron/backfill default to this constant.
 */
export const DEFAULT_LEADERBOARD_RANK_SCORING_VERSION = '2026-01-es-parity-v1';

/** Max points returned by GET .../rank-history (daily) before clamping. */
export const RANK_HISTORY_MAX_POINTS = 2000;
