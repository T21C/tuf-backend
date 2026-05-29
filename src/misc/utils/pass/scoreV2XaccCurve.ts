import {
  SCORE_V2_ZERO_MISS_MULTIPLIER,
  scoreV2MtpFromMisses,
} from './CalcScore.js';

/**
 * Normalized hyperbola xacc multiplier on [cutoff, 1):
 *   t = (xacc - cutoff) / (1 - cutoff)
 *   u(t) = (g(t) - 1) / (topMultiplier - 1)   with u(0)=0, u(1)=1
 *   mtp  = 1 + (topMultiplier - 1) * u(t)
 *
 * Site defaults: E = 0.0054017154, G = 5.51289781 at the 95% anchor (xacc mult = 1).
 */

export type XaccCurveConfig = {
  cutoff?: number;
  topMultiplier?: number;
  poleOffset?: number;
};

export const XACC_CURVE_DEFAULTS: Required<XaccCurveConfig> = {
  cutoff: 0.95,
  topMultiplier: 5.51289781,
  poleOffset: 0.0054017154,
};

/** Site-default interior pin accuracies (fractions, not %). */
export const XACC_SITE_DEFAULT_PIN1_ACC = 0.985;
export const XACC_SITE_DEFAULT_PIN2_ACC = 0.995;

/** Reject only non-physical / extreme pole offsets (E must be in (0, 1)). */
export const XACC_POLE_OFFSET_MIN = 1e-12;
export const XACC_POLE_OFFSET_MAX = 1 - 1e-9;

/** Reject only non-physical / extreme top multipliers (G must be in (1, 1000)). */
export const XACC_TOP_MULTIPLIER_MIN = 1 + 1e-9;
export const XACC_TOP_MULTIPLIER_MAX = 999;

/** Minimum accuracy gap between pin 1 and pin 2 (0.2%) — slider / UI only. */
export const XACC_PIN_ACC_GAP = 0.002;
/** Minimum gap for hyperbola fit (pass-derived pins may be closer than UI gap). */
export const XACC_FIT_MIN_PIN_ACC_GAP = 1e-9;
/** Interior pin 1 lower bound — above cutoff. */
export const XACC_PIN_ACC_MIN = XACC_CURVE_DEFAULTS.cutoff + 0.005;
/** Interior pin 1 accuracy upper bound (< 100%). */
export const XACC_PIN_ACC_MAX = 0.9995;
/** Pin 2 may sit at exactly 100%. */
export const XACC_PIN2_ACC_MAX = 1;
/** Pin scores may span 0 .. pure-perfect score (not tied to G validation cap). */
export const XACC_PIN_MULT_MIN = 0;
export const XACC_FIT_TOLERANCE = 1e-6;

export type LevelXaccCurveSource = {
  xaccPoleOffset?: number | null;
  xaccTopMultiplier?: number | null;
  xaccCurveMeta?: unknown | null;
  xaccCurve?: XaccCurveConfig | null;
};

/** DB / API fields → overrides, or undefined when both null (site defaults). */
export function pickLevelXaccCurve(
  level?: LevelXaccCurveSource | null,
): XaccCurveConfig | undefined {
  if (!level) return undefined;
  const meta = parseXaccCurveMeta(level.xaccCurveMeta);
  const pole =
    (meta?.poleOffset ?? null) ??
    level.xaccPoleOffset ??
    level.xaccCurve?.poleOffset;
  const top =
    (meta?.topMultiplier ?? null) ??
    level.xaccTopMultiplier ??
    level.xaccCurve?.topMultiplier;
  if (pole == null && top == null) return undefined;
  return {
    poleOffset: pole ?? XACC_CURVE_DEFAULTS.poleOffset,
    topMultiplier: top ?? XACC_CURVE_DEFAULTS.topMultiplier,
  };
}

export function parseXaccCurveMeta(
  raw: unknown,
): { poleOffset?: number; topMultiplier?: number; pins?: unknown } | null {
  if (!raw) return null;
  let obj: unknown = raw;
  if (typeof obj === 'string') {
    try {
      obj = JSON.parse(obj);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object') return null;
  return obj as any;
}

export function resolveXaccCurveForLevelData(
  levelData?: LevelXaccCurveSource | null,
): XaccCurveConfig | undefined {
  if (!levelData) return undefined;
  if (levelData.xaccCurve) return levelData.xaccCurve;
  return pickLevelXaccCurve(levelData);
}

export function resolveXaccCurveConfig(
  overrides?: XaccCurveConfig | null,
): Required<XaccCurveConfig> {
  if (!overrides) {
    return { ...XACC_CURVE_DEFAULTS };
  }
  return {
    cutoff: overrides.cutoff ?? XACC_CURVE_DEFAULTS.cutoff,
    topMultiplier: overrides.topMultiplier ?? XACC_CURVE_DEFAULTS.topMultiplier,
    poleOffset: overrides.poleOffset ?? XACC_CURVE_DEFAULTS.poleOffset,
  };
}

export function xaccHyperbolaCoefficients(cfg: Required<XaccCurveConfig>): {
  A: number;
  B: number;
  span: number;
  G: number;
  E: number;
} {
  const span = 1 - cfg.cutoff;
  const G = cfg.topMultiplier;
  const E = cfg.poleOffset;
  const A = ((G - 1) * E * (span + E)) / span;
  const B = 1 - A / (span + E);
  return { A, B, span, G, E };
}

/** Unit shape u(t) in [0, 1], with u(0)=0 and u(1)=1. */
export function xaccUnitShape(t: number, cfg: Required<XaccCurveConfig>): number {
  const { A, B, span, G, E } = xaccHyperbolaCoefficients(cfg);
  const g = B - A / (span * (t - 1) - E);
  return (g - 1) / (G - 1);
}

/** Raw hyperbola value g(t) in t-space (not normalized). */
export function xaccShapeAtT(t: number, cfg: Required<XaccCurveConfig>): number {
  const { A, B, span, E } = xaccHyperbolaCoefficients(cfg);
  const D = span * (t - 1) - E;
  if (Math.abs(D) < 1e-14) return NaN;
  return B - A / D;
}

export type HyperbolaThreePointFit =
  | {
      ok: true;
      a: number;
      b: number;
      c: number;
      predict: (x: number) => number;
    }
  | { ok: false; error: string };

export function fitHyperbolaThreePoints(
  points: [[number, number], [number, number], [number, number]],
): HyperbolaThreePointFit {
  const [[x1, y1], [x2, y2], [x3, y3]] = points;
  const xs = [x1, x2, x3];
  const ys = [y1, y2, y3];
  if (xs.some((x) => !Number.isFinite(x)) || ys.some((y) => !Number.isFinite(y))) {
    return { ok: false, error: 'Invalid hyperbola sample points' };
  }
  const maxX = Math.max(x1, x2, x3);

  const slopeResidual = (c: number) => {
    const u1 = 1 / (x1 - c);
    const u2 = 1 / (x2 - c);
    const u3 = 1 / (x3 - c);
    if (!Number.isFinite(u1) || !Number.isFinite(u2) || !Number.isFinite(u3)) {
      return NaN;
    }
    const d1 = u2 - u1;
    const d2 = u3 - u2;
    if (Math.abs(d1) < 1e-14 || Math.abs(d2) < 1e-14) return NaN;
    return (y2 - y1) / d1 - (y3 - y2) / d2;
  };

  let left = Math.max(maxX, 1) + 1e-6;
  let right = 1 + XACC_POLE_OFFSET_MAX + 1e-4;

  let fLeft = slopeResidual(left);
  let fRight = slopeResidual(right);

  if (!Number.isFinite(fLeft) || !Number.isFinite(fRight)) {
    return { ok: false, error: 'No valid hyperbola fits these pins' };
  }

  if (fLeft * fRight > 0) {
    const samples = 256;
    let bracketLo: number | null = null;
    let bracketHi: number | null = null;
    let prevC = left;
    let prevF = fLeft;
    for (let i = 1; i <= samples; i += 1) {
      const c = left + ((right - left) * i) / samples;
      const f = slopeResidual(c);
      if (!Number.isFinite(f) || !Number.isFinite(prevF)) {
        prevC = c;
        prevF = f;
        continue;
      }
      if (prevF * f <= 0) {
        bracketLo = prevC;
        bracketHi = c;
        fLeft = prevF;
        fRight = f;
        break;
      }
      prevC = c;
      prevF = f;
    }
    if (bracketLo == null) {
      return { ok: false, error: 'No valid hyperbola fits these pins' };
    }
    left = bracketLo;
    right = bracketHi ?? right;
  }

  for (let i = 0; i < 100; i += 1) {
    const mid = (left + right) / 2;
    const fMid = slopeResidual(mid);
    if (!Number.isFinite(fMid)) {
      return { ok: false, error: 'No valid hyperbola fits these pins' };
    }
    if (Math.abs(fMid) < XACC_FIT_TOLERANCE) {
      left = mid;
      right = mid;
      break;
    }
    if (fLeft * fMid <= 0) {
      right = mid;
      fRight = fMid;
    } else {
      left = mid;
      fLeft = fMid;
    }
  }

  const c = (left + right) / 2;
  const u2 = 1 / (x2 - c);
  const u3 = 1 / (x3 - c);
  const du = u3 - u2;
  if (Math.abs(du) < 1e-14) {
    return { ok: false, error: 'Pin accuracies are too close to fit' };
  }
  const b = -(y3 - y2) / du;
  const a = y2 + b * u2;

  const predict = (x: number) => {
    const den = x - c;
    if (Math.abs(den) < 1e-14) return NaN;
    return a - b / den;
  };

  return { ok: true, a, b, c, predict };
}

export function xaccParamsFromHyperbolaCoefficients(
  a: number,
  b: number,
  c: number,
): { poleOffset: number; topMultiplier: number } {
  const poleOffset = c - 1;
  const topMultiplier = a - b / (1 - c);
  return { poleOffset, topMultiplier };
}

export function validateXaccCurveParams(
  poleOffset: number,
  topMultiplier: number,
): { ok: true } | { ok: false; error: string } {
  const E = Number(poleOffset);
  const G = Number(topMultiplier);
  if (!Number.isFinite(E) || E <= 0) {
    return { ok: false, error: 'Pole offset (E) must be a positive number' };
  }
  if (E >= 1) {
    return { ok: false, error: 'Pole offset (E) must be less than 1' };
  }
  if (!Number.isFinite(G) || G <= 1) {
    return { ok: false, error: 'Top multiplier (G) must be greater than 1' };
  }
  if (G >= 1000) {
    return { ok: false, error: 'Top multiplier (G) must be less than 1000' };
  }
  return { ok: true };
}

export function chordMultiplier(
  cutoff: number,
  accA: number,
  multA: number,
  accTarget: number,
): number {
  if (accA <= cutoff) return 1;
  return 1 + (multA - 1) * (accTarget - cutoff) / (accA - cutoff);
}

export function minPin2Multiplier(
  cutoff: number,
  accX: number,
  multX: number,
  accY: number,
): number {
  return chordMultiplier(cutoff, accX, multX, accY);
}

export function clampPin2Multiplier(
  cutoff: number,
  accX: number,
  multX: number,
  accY: number,
  multY: number,
): number {
  return Math.max(multY, minPin2Multiplier(cutoff, accX, multX, accY));
}

export function minPin2Score(
  cutoff: number,
  accX: number,
  scoreX: number,
  accY: number,
  baseScore: number,
): number {
  const base = Number(baseScore);
  if (!Number.isFinite(base) || base <= 0) return NaN;
  const multX = scoreX / base;
  return base * minPin2Multiplier(cutoff, accX, multX, accY);
}

export function clampPin2Score(
  cutoff: number,
  accX: number,
  scoreX: number,
  accY: number,
  scoreY: number,
  baseScore: number,
): number {
  return Math.max(scoreY, minPin2Score(cutoff, accX, scoreX, accY, baseScore));
}

export type XaccPinValues = {
  accX: number;
  scoreX: number;
  accY: number;
  scoreY: number;
  multX: number;
  multY: number;
  baseScore: number;
  cutoff: number;
};

export function xaccMultiplierFromDisplayScore(
  displayScore: number,
  baseScore: number,
  scoreV2Mtp: number = SCORE_V2_ZERO_MISS_MULTIPLIER,
): number {
  const base = Number(baseScore);
  const mtp = Number(scoreV2Mtp);
  if (!Number.isFinite(base) || base <= 0 || !Number.isFinite(mtp) || mtp <= 0) {
    return NaN;
  }
  return Number(displayScore) / (base * mtp);
}

export function resolveScoreV2RatingBase(
  accuracy: number,
  levelBaseScore: number,
  ppBaseScore?: number | null,
): number {
  const acc = Number(accuracy);
  const level = Number(levelBaseScore);
  const pp = Number(ppBaseScore);
  if (acc >= 1 - 1e-9 && Number.isFinite(pp) && pp > 0) {
    return pp;
  }
  if (Number.isFinite(level) && level > 0) {
    return level;
  }
  return 100;
}

export function displayScoreFromXaccMultiplier(
  mult: number,
  baseScore: number,
  scoreV2Mtp: number = SCORE_V2_ZERO_MISS_MULTIPLIER,
): number {
  const base = Number(baseScore);
  const m = Number(mult);
  const mtp = Number(scoreV2Mtp);
  if (!Number.isFinite(base) || base <= 0) return 0;
  if (!Number.isFinite(m) || !Number.isFinite(mtp)) return 0;
  return base * m * mtp;
}

export function xaccCurveToPinValues(
  cfg: XaccCurveConfig | null | undefined,
  baseScore: number,
): XaccPinValues {
  const resolved = resolveXaccCurveConfig(cfg);
  const base = Math.max(1, Number(baseScore) || 100);
  const accX = XACC_SITE_DEFAULT_PIN1_ACC;
  const accY = XACC_SITE_DEFAULT_PIN2_ACC;
  const multX = xaccMultiplier(accX, 0, resolved);
  const multY = xaccMultiplier(accY, 0, resolved);
  return {
    accX,
    scoreX: displayScoreFromXaccMultiplier(multX, base),
    accY,
    scoreY: displayScoreFromXaccMultiplier(multY, base),
    multX,
    multY,
    baseScore: base,
    cutoff: resolved.cutoff,
  };
}

export type FitXaccCurveFromPinsInput = {
  accX: number;
  accY: number;
  /** Plotted ScoreV2 at accX for this pin's miss slice. */
  scoreX: number;
  scoreY: number;
  baseScore: number;
  cutoff?: number;
  hitTiles?: number;
  missesX?: number;
  missesY?: number;
  ppBaseScore?: number | null;
};

export type FitXaccCurveFromPinsResult =
  | { ok: true; poleOffset: number; topMultiplier: number }
  | { ok: false; error: string };

export function fitXaccCurveFromPins(
  pins: FitXaccCurveFromPinsInput,
): FitXaccCurveFromPinsResult {
  const cutoff = pins.cutoff ?? XACC_CURVE_DEFAULTS.cutoff;
  const accX = Number(pins.accX);
  const accY = Number(pins.accY);
  const scoreX = Number(pins.scoreX);
  const scoreY = Number(pins.scoreY);
  const baseScore = Number(pins.baseScore);

  if (
    !Number.isFinite(accX) ||
    !Number.isFinite(accY) ||
    !Number.isFinite(scoreX) ||
    !Number.isFinite(scoreY) ||
    !Number.isFinite(baseScore)
  ) {
    return { ok: false, error: 'Invalid pin values' };
  }
  if (baseScore <= 0) {
    return { ok: false, error: 'Level base score must be positive' };
  }
  if (
    accX <= cutoff ||
    accY > XACC_PIN2_ACC_MAX + 1e-9 ||
    accY <= accX + XACC_FIT_MIN_PIN_ACC_GAP
  ) {
    return {
      ok: false,
      error: 'Pin accuracies must satisfy cutoff < X < Y (Y at most 100%)',
    };
  }

  const hitTiles = Math.max(1, Math.floor(Number(pins.hitTiles)) || 100);
  const missesX = Math.max(0, Math.floor(Number(pins.missesX)) || 0);
  const missesY = Math.max(0, Math.floor(Number(pins.missesY)) || 0);
  const baseX = resolveScoreV2RatingBase(accX, baseScore, pins.ppBaseScore);
  const baseY = resolveScoreV2RatingBase(accY, baseScore, pins.ppBaseScore);
  const mtpX = scoreV2MtpFromMisses(missesX, hitTiles);
  const mtpY = scoreV2MtpFromMisses(missesY, hitTiles);
  const multX = xaccMultiplierFromDisplayScore(scoreX, baseX, mtpX);
  const multY = xaccMultiplierFromDisplayScore(scoreY, baseY, mtpY);
  if (multX < XACC_PIN_MULT_MIN || multY < XACC_PIN_MULT_MIN) {
    return { ok: false, error: 'Pin scores cannot be negative' };
  }

  const hyperbola = fitHyperbolaThreePoints([
    [cutoff, 1],
    [accX, multX],
    [accY, multY],
  ]);
  if (!hyperbola.ok) {
    return { ok: false, error: hyperbola.error };
  }

  const { poleOffset: E, topMultiplier: G } = xaccParamsFromHyperbolaCoefficients(
    hyperbola.a,
    hyperbola.b,
    hyperbola.c,
  );

  const paramCheck = validateXaccCurveParams(E, G);
  if (!paramCheck.ok) {
    return paramCheck;
  }

  const verifyX = hyperbola.predict(accX);
  const verifyY = hyperbola.predict(accY);
  const anchorMult = hyperbola.predict(cutoff);
  if (
    !Number.isFinite(verifyX) ||
    !Number.isFinite(verifyY) ||
    Math.abs(verifyX - multX) > XACC_FIT_TOLERANCE ||
    Math.abs(verifyY - multY) > XACC_FIT_TOLERANCE
  ) {
    return { ok: false, error: 'Pin fit did not converge' };
  }
  if (!Number.isFinite(anchorMult) || Math.abs(anchorMult - 1) > 1e-3) {
    return { ok: false, error: 'Fixed 95% anchor does not match this hyperbola' };
  }

  return { ok: true, poleOffset: E, topMultiplier: G };
}

export function xaccMultiplier(
  xacc: number,
  baseScore: number,
  curveOverrides?: XaccCurveConfig | null,
): number {
  const cfg = resolveXaccCurveConfig(curveOverrides);
  const xaccPct = xacc * 100;

  if (xaccPct < cfg.cutoff * 100) {
    return 1;
  }
  if (xaccPct < 100) {
    const span = 1 - cfg.cutoff;
    const t = (xacc - cfg.cutoff) / span;
    const clamped = Math.max(0, Math.min(1, t));
    const u = xaccUnitShape(clamped, cfg);
    return 1 + (cfg.topMultiplier - 1) * u;
  }
  if (xaccPct === 100) {
    const a = 2100;
    const k = 14;
    const h = -a / (k - 6);
    return -a / (baseScore - h) + k;
  }
  return 1;
}
