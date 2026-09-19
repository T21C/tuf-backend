import { cloneJudgements, isAncient5405Pattern, tilecount as judgementHitCount, unwrapJudgements, type IJudgements } from './CalcAcc.js';
import { isLegacyAdofaiVersion } from './adofaiVersion.js';
import {
  addPassMetaFlag,
  hasPassMetaFlag,
  passMetaFlags,
  toPassMetaFlags,
} from './passMetaFlags.js';

export type MidspinDecrementSkipReason =
  | 'already_applied'
  | 'latest_era'
  | 'midspin_missing'
  | 'perfect_lt_midspin'
  | null;

export type MidspinDecrementResult = {
  judgements: IJudgements;
  passMetaFlags: bigint;
  applied: boolean;
  skippedReason: MidspinDecrementSkipReason;
  subtracted: number;
};

function midspinInt(midspinCount: unknown): number | null {
  if (midspinCount == null || midspinCount === '') return null;
  const n = typeof midspinCount === 'number' ? midspinCount : Number(midspinCount);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.floor(n));
}

/** Treat missing/invalid midspin counts as 0 for difference math. */
export function midspinCountOrZero(midspinCount: unknown): number {
  return midspinInt(midspinCount) ?? 0;
}

/**
 * Amount to add to each pass Perfect when midspinCount changes.
 * More midspins → fewer Perfects (legacy charts counted midspins as Perfect).
 */
export function perfectsDeltaFromMidspinChange(
  oldMidspinCount: unknown,
  newMidspinCount: unknown,
): number {
  return midspinCountOrZero(oldMidspinCount) - midspinCountOrZero(newMidspinCount);
}

export type PerfectsDeltaSkipReason = 'no_change' | 'would_go_negative' | null;

export function applyPerfectsDelta(
  perfect: number,
  delta: number,
): {perfect: number; applied: boolean; skippedReason: PerfectsDeltaSkipReason} {
  const current = Number.isFinite(perfect) ? Math.max(0, Math.floor(perfect)) : 0;
  if (!Number.isFinite(delta) || delta === 0) {
    return {perfect: current, applied: false, skippedReason: 'no_change'};
  }
  const next = current + Math.trunc(delta);
  if (next < 0) {
    return {perfect: current, applied: false, skippedReason: 'would_go_negative'};
  }
  return {perfect: next, applied: true, skippedReason: null};
}

function chartTilecountInt(raw: unknown): number | null {
  if (raw == null || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.floor(n));
}

/** Playable tiles: persisted tilecount minus auto tiles (midspins already excluded from tilecount). */
export function effectiveChartTilecount(
  tilecount: unknown,
  autoTileCount: unknown = 0,
): number | null {
  const tiles = chartTilecountInt(tilecount);
  if (tiles == null) return null;
  const auto = chartTilecountInt(autoTileCount) ?? 0;
  return Math.max(tiles - auto, 0);
}

export type MidspinDifferenceSkipReason =
  | 'latest_era'
  | 'ancient_5405'
  | 'tilecount_missing'
  | 'inexact'
  | 'would_go_negative'
  | 'no_change';

/**
 * Exact hit totals that may receive a midspin Perfects difference.
 * First-time set (old 0 → new N): only tilecount + N (uncorrected extras).
 * Correction (old M → new N): tilecount (already rewritten) and tilecount + M.
 */
export function exactHitTotalsForMidspinDifference(
  tilecount: unknown,
  autoTileCount: unknown,
  oldMidspinCount: unknown,
  newMidspinCount: unknown,
): Set<number> {
  const totals = new Set<number>();
  const playable = effectiveChartTilecount(tilecount, autoTileCount);
  if (playable == null) return totals;
  const oldM = midspinCountOrZero(oldMidspinCount);
  const newM = midspinCountOrZero(newMidspinCount);
  if (oldM === 0) {
    if (newM > 0) totals.add(playable + newM);
    return totals;
  }
  totals.add(playable);
  totals.add(playable + oldM);
  return totals;
}

/** Whether this pass's hit total is an exact chart match (not an invalid/inexact clear). */
export function shouldApplyMidspinPerfectsDifference(params: {
  judgements: unknown;
  adofaiVersion: number;
  tilecount: unknown;
  autoTileCount?: unknown;
  oldMidspinCount: unknown;
  newMidspinCount: unknown;
  perfectDelta: number;
}): {apply: boolean; reason: MidspinDifferenceSkipReason | null} {
  if (!isLegacyAdofaiVersion(params.adofaiVersion)) {
    return {apply: false, reason: 'latest_era'};
  }
  if (isAncient5405Pattern(params.judgements)) {
    return {apply: false, reason: 'ancient_5405'};
  }
  const playable = effectiveChartTilecount(params.tilecount, params.autoTileCount);
  if (playable == null) {
    return {apply: false, reason: 'tilecount_missing'};
  }
  const totals = exactHitTotalsForMidspinDifference(
    params.tilecount,
    params.autoTileCount,
    params.oldMidspinCount,
    params.newMidspinCount,
  );
  const hits = judgementHitCount(params.judgements);
  if (!totals.has(hits)) {
    return {apply: false, reason: 'inexact'};
  }
  const perfect = unwrapJudgements(params.judgements).perfect;
  const deltaResult = applyPerfectsDelta(perfect, params.perfectDelta);
  if (!deltaResult.applied) {
    return {
      apply: false,
      reason: deltaResult.skippedReason === 'would_go_negative' ? 'would_go_negative' : 'no_change',
    };
  }
  return {apply: true, reason: null};
}

/**
 * Subtract midspinCount from Perfect for pre-3.4.0 / v2 clears.
 * Idempotent via MIDSPIN_PERFECTS_REMOVED. midspinCount 0 still sets the bit.
 */
export function applyMidspinPerfectDecrement(params: {
  judgements: IJudgements | unknown;
  adofaiVersion: number;
  passMetaFlags?: unknown;
  midspinCount: unknown;
}): MidspinDecrementResult {
  const judgements = cloneJudgements(params.judgements);
  let flags = toPassMetaFlags(params.passMetaFlags);

  if (hasPassMetaFlag(flags, passMetaFlags.MIDSPIN_PERFECTS_REMOVED)) {
    return {
      judgements,
      passMetaFlags: flags,
      applied: false,
      skippedReason: 'already_applied',
      subtracted: 0,
    };
  }

  if (!isLegacyAdofaiVersion(params.adofaiVersion)) {
    return {
      judgements,
      passMetaFlags: flags,
      applied: false,
      skippedReason: 'latest_era',
      subtracted: 0,
    };
  }

  const midspin = midspinInt(params.midspinCount);
  if (midspin == null) {
    return {
      judgements,
      passMetaFlags: flags,
      applied: false,
      skippedReason: 'midspin_missing',
      subtracted: 0,
    };
  }

  flags = addPassMetaFlag(flags, passMetaFlags.MIDSPIN_PERFECTS_REMOVED);

  if (midspin === 0) {
    return {
      judgements,
      passMetaFlags: flags,
      applied: false,
      skippedReason: null,
      subtracted: 0,
    };
  }

  if (judgements.perfect < midspin) {
    return {
      judgements,
      passMetaFlags: toPassMetaFlags(params.passMetaFlags),
      applied: false,
      skippedReason: 'perfect_lt_midspin',
      subtracted: 0,
    };
  }

  judgements.perfect -= midspin;
  return {
    judgements,
    passMetaFlags: flags,
    applied: true,
    skippedReason: null,
    subtracted: midspin,
  };
}

export type MidspinRewriteSkipSilentReason = 'already_applied' | 'latest_era';
export type MidspinRewriteSkipCsvReason = 'no_download' | 'midspin_null' | 'ancient_5405' | 'inexact';
export type MidspinRewriteClassification =
  | {action: 'skip_silent'; reason: MidspinRewriteSkipSilentReason}
  | {action: 'skip_csv'; reason: MidspinRewriteSkipCsvReason}
  | {action: 'flag_only'}
  | {action: 'subtract'};

/** Bulk rewrite decision: env-free; caller supplies CDN presence. */
export function classifyMidspinRewrite(params: {
  adofaiVersion: number;
  passMetaFlags?: unknown;
  hasCdnDownload: boolean;
  midspinCount: unknown;
  tilecount: unknown;
  judgements: unknown;
}): MidspinRewriteClassification {
  if (hasPassMetaFlag(params.passMetaFlags, passMetaFlags.MIDSPIN_PERFECTS_REMOVED)) {
    return {action: 'skip_silent', reason: 'already_applied'};
  }
  if (!isLegacyAdofaiVersion(params.adofaiVersion)) {
    return {action: 'skip_silent', reason: 'latest_era'};
  }
  if (!params.hasCdnDownload) {
    return {action: 'skip_csv', reason: 'no_download'};
  }
  const midspin = midspinInt(params.midspinCount);
  if (midspin == null) {
    return {action: 'skip_csv', reason: 'midspin_null'};
  }
  if (isAncient5405Pattern(params.judgements)) {
    return {action: 'skip_csv', reason: 'ancient_5405'};
  }

  const hits = judgementHitCount(params.judgements);
  const chartTiles = chartTilecountInt(params.tilecount);
  const judgements = unwrapJudgements(params.judgements);

  if (midspin === 0 || (chartTiles != null && hits === chartTiles)) {
    return {action: 'flag_only'};
  }
  if (chartTiles != null && hits === chartTiles + midspin && judgements.perfect >= midspin) {
    return {action: 'subtract'};
  }
  return {action: 'skip_csv', reason: 'inexact'};
}

export function willApplyMidspinDecrement(params: {
  adofaiVersion: number;
  passMetaFlags?: unknown;
  midspinCount: unknown;
  perfect?: unknown;
}): boolean {
  if (hasPassMetaFlag(params.passMetaFlags, passMetaFlags.MIDSPIN_PERFECTS_REMOVED)) {
    return false;
  }
  if (!isLegacyAdofaiVersion(params.adofaiVersion)) {
    return false;
  }
  const midspin = midspinInt(params.midspinCount);
  if (midspin == null || midspin === 0) {
    return false;
  }
  if (params.perfect != null) {
    const p = Number(params.perfect);
    if (!Number.isFinite(p) || Math.floor(p) < midspin) return false;
  }
  return true;
}
