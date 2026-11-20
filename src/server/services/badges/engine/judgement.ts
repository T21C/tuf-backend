export type JudgementBuckets = {
  earlyDouble: number;
  earlySingle: number;
  ePerfect: number;
  perfectMinus: number;
  perfect: number;
  perfectPlus: number;
  lPerfect: number;
  lateSingle: number;
  lateDouble: number;
};

export const JUDGEMENT_KEYS = [
  'earlyDouble',
  'earlySingle',
  'ePerfect',
  'perfectMinus',
  'perfect',
  'perfectPlus',
  'lPerfect',
  'lateSingle',
  'lateDouble',
] as const;

export type JudgementKey = (typeof JUDGEMENT_KEYS)[number];

export function emptyJudgements(): JudgementBuckets {
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

export function coerceJudgements(raw: Partial<JudgementBuckets> | null | undefined): JudgementBuckets {
  const out = emptyJudgements();
  if (!raw) return out;
  for (const key of JUDGEMENT_KEYS) {
    const value = Number(raw[key] ?? 0);
    out[key] = Number.isFinite(value) ? value : 0;
  }
  return out;
}

/** Same 5 / 40 / 5 placeholder as CalcAcc.isAncient5405Pattern. */
export function isAncientPlaceholder(raw: JudgementBuckets): boolean {
  return (
    raw.ePerfect === 5 &&
    raw.perfect === 40 &&
    raw.lPerfect === 5 &&
    raw.earlySingle === 0 &&
    raw.perfectMinus === 0 &&
    raw.perfectPlus === 0 &&
    raw.lateSingle === 0
  );
}

/** Too-late is ignored. Misses are the too-early bucket. */
export function judgementTotal(raw: JudgementBuckets): number {
  return (
    raw.earlyDouble +
    raw.earlySingle +
    raw.ePerfect +
    raw.perfectMinus +
    raw.perfect +
    raw.perfectPlus +
    raw.lPerfect +
    raw.lateSingle
  );
}

/** Center perfects, plus perfect-minus and perfect-plus in X-perfect mode. */
export function perfectCount(raw: JudgementBuckets, xMode: boolean): number {
  return raw.perfect + (xMode ? raw.perfectMinus + raw.perfectPlus : 0);
}

export function isPpMinusOne(raw: JudgementBuckets, xMode: boolean): boolean {
  const total = judgementTotal(raw);
  if (total <= 0 || raw.earlyDouble !== 0) return false;
  return total - perfectCount(raw, xMode) === 1;
}

export function isSymmetry(raw: JudgementBuckets, purePerfect: boolean): boolean {
  if (purePerfect || judgementTotal(raw) <= 0) return false;
  return raw.ePerfect === raw.lPerfect && raw.earlySingle === raw.lateSingle;
}

export function isTechnicallyPure(raw: JudgementBuckets): boolean {
  return raw.ePerfect === 0 && raw.earlySingle > 0 && raw.lateSingle > 0 && judgementTotal(raw) > 0;
}

export function isAsymmetry(raw: JudgementBuckets, xMode: boolean): boolean {
  const perfects = perfectCount(raw, xMode);
  const buckets = [
    raw.earlyDouble,
    raw.earlySingle,
    raw.ePerfect,
    raw.lPerfect,
    raw.lateSingle,
    xMode ? 0 : raw.perfectMinus,
    xMode ? 0 : raw.perfectPlus,
  ];
  return buckets.some((count) => count > perfects) && judgementTotal(raw) > 0;
}

/** Exactly `count` in one bucket that is neither perfects nor misses. */
export function hasGamma(raw: JudgementBuckets, count: number): boolean {
  return (
    raw.earlySingle === count ||
    raw.ePerfect === count ||
    raw.lPerfect === count ||
    raw.lateSingle === count ||
    raw.perfectMinus === count ||
    raw.perfectPlus === count
  );
}
