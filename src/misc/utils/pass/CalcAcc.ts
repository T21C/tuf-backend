export interface IJudgements {
  earlyDouble: number;
  earlySingle: number;
  ePerfect: number;
  perfectMinus: number;
  perfect: number;
  perfectPlus: number;
  lPerfect: number;
  lateSingle: number;
  lateDouble: number;
}

export const JUDGEMENT_KEYS: Array<keyof IJudgements> = [
  'earlyDouble',
  'earlySingle',
  'ePerfect',
  'perfectMinus',
  'perfect',
  'perfectPlus',
  'lPerfect',
  'lateSingle',
  'lateDouble',
];

export function emptyJudgements(): IJudgements {
  return {
    earlyDouble: 0,
    earlySingle: 0,
    ePerfect: 0,
    perfectMinus: 0,
    perfect: 0,
    perfectPlus: 0,
    lPerfect: 0,
    lateSingle: 0,
    lateDouble: 0,
  };
}

function n(v: unknown): number {
  const num = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(num) ? num : 0;
}

export function unwrapJudgements(inp: unknown): IJudgements {
  if (!inp || typeof inp !== 'object') {
    return emptyJudgements();
  }
  const raw = 'dataValues' in inp && (inp as {dataValues?: unknown}).dataValues
    ? ((inp as {dataValues: Record<string, unknown>}).dataValues)
    : (inp as Record<string, unknown>);
  return {
    earlyDouble: n(raw.earlyDouble),
    earlySingle: n(raw.earlySingle),
    ePerfect: n(raw.ePerfect),
    perfectMinus: n(raw.perfectMinus),
    perfect: n(raw.perfect),
    perfectPlus: n(raw.perfectPlus),
    lPerfect: n(raw.lPerfect),
    lateSingle: n(raw.lateSingle),
    lateDouble: n(raw.lateDouble),
  };
}

export function cloneJudgements(inp: unknown): IJudgements {
  return unwrapJudgements(inp);
}

export function sumJudgements(inp: IJudgements | unknown): number {
  const j = unwrapJudgements(inp);
  return (
    j.earlyDouble +
    j.earlySingle +
    j.ePerfect +
    j.perfectMinus +
    j.perfect +
    j.perfectPlus +
    j.lPerfect +
    j.lateDouble +
    j.lateSingle
  );
}

/** Hits that count toward chart tilecount (excludes too-early / too-late). */
export function tilecount(inp: IJudgements | unknown): number {
  const j = unwrapJudgements(inp);
  return (
    j.earlySingle +
    j.ePerfect +
    j.perfectMinus +
    j.perfect +
    j.perfectPlus +
    j.lPerfect +
    j.lateSingle
  );
}

/**
 * Achievable manual judgements: persisted tilecount minus auto-play tiles.
 * Returns null when tilecount is missing or not a finite number.
 */
export function getEffectiveTilecount(
  levelTilecount: unknown,
  autoTileCount: unknown = 0,
): number | null {
  if (levelTilecount == null || levelTilecount === '') return null;
  const tc = typeof levelTilecount === 'number' ? levelTilecount : Number(levelTilecount);
  if (!Number.isFinite(tc)) return null;
  const tileInt = Math.floor(tc);
  const autoRaw =
    typeof autoTileCount === 'number' ? autoTileCount : Number(autoTileCount);
  const autoInt = Number.isFinite(autoRaw) ? Math.floor(autoRaw) : 0;
  return Math.max(tileInt - autoInt, 0);
}

/**
 * True when the chart has a positive achievable tilecount and judgement hits
 * (tilecount buckets, excluding doubles) do not equal that count.
 */
export function isWrongJudgement(
  judgements: IJudgements | unknown,
  chart: {tilecount?: unknown; autoTileCount?: unknown},
): boolean {
  const effective = getEffectiveTilecount(chart.tilecount, chart.autoTileCount);
  if (effective == null || effective <= 0) return false;
  return tilecount(judgements) !== effective;
}

/**
 * Weighted xacc. Perfect− / Perfect+ count as 1.0 like Perfect.
 * Must stay in sync with MySQL `calculate_accuracy` (judgement accuracy triggers).
 */
export function calcAcc(inp: IJudgements | unknown): number {
  if (!inp) return 0;
  const judgements = unwrapJudgements(inp);
  const total = sumJudgements(judgements);
  if (!total) return 0;

  const perfectBand = judgements.perfectMinus + judgements.perfect + judgements.perfectPlus;
  return (
    (perfectBand +
      (judgements.ePerfect + judgements.lPerfect) * 0.75 +
      (judgements.earlySingle + judgements.lateSingle) * 0.4 +
      (judgements.earlyDouble + judgements.lateDouble) * 0.2) /
    total
  );
}

/**
 * Internal sort key. Same buckets as `calcAcc` except Perfect− / Perfect+ weigh 0.9.
 * Must stay in sync with MySQL `calculate_xaccuracy`. Never displayed.
 */
export function calcXAcc(inp: IJudgements | unknown): number {
  if (!inp) return 0;
  const judgements = unwrapJudgements(inp);
  const total = sumJudgements(judgements);
  if (!total) return 0;

  return (
    (judgements.perfect +
      (judgements.perfectMinus + judgements.perfectPlus) * 0.9 +
      (judgements.ePerfect + judgements.lPerfect) * 0.75 +
      (judgements.earlySingle + judgements.lateSingle) * 0.4 +
      (judgements.earlyDouble + judgements.lateDouble) * 0.2) /
    total
  );
}

/** Every hit is an x-perfect (center perfect). Perfect− / Perfect+ still score 1.0, so accuracy alone is not enough. */
export function isPureXPerfect(
  judgements: unknown,
  isXPerfectMode: boolean | null | undefined,
): boolean {
  if (!isXPerfectMode) return false;
  const j = unwrapJudgements(judgements);
  const total = sumJudgements(j);
  return total > 0 && j.perfect === total;
}

/** Ancient placeholder judgements (no results screen): 5 / 40 / 5 with other hit buckets 0. */
export function isAncient5405Pattern(inp: unknown): boolean {
  const j = unwrapJudgements(inp);
  return (
    j.ePerfect === 5 &&
    j.perfect === 40 &&
    j.lPerfect === 5 &&
    j.earlySingle === 0 &&
    j.perfectMinus === 0 &&
    j.perfectPlus === 0 &&
    j.lateSingle === 0
  );
}
