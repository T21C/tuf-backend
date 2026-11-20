export type RoundMode = 'none' | 'ceil';
export type CurveDirection = 'up' | 'down';

export type Curve = {
  start: number;
  step: number;
  round: RoundMode;
  direction: CurveDirection;
};

export type TierLabel = {
  minTier: number;
  label: string;
};

export function rawBoundary(curve: Curve, tier: number): number {
  const index = Math.max(1, tier);
  if (curve.direction === 'down') {
    return curve.start - (index - 1) * curve.step;
  }
  return curve.start + (index - 1) * curve.step;
}

export function shownRequirement(curve: Curve, tier: number): number {
  const raw = rawBoundary(curve, Math.max(1, tier));
  if (curve.round === 'ceil') return Math.ceil(raw - 1e-9);
  return raw;
}

/** Largest tier whose raw boundary the credit has reached. */
export function tierForCredit(curve: Curve, credit: number): number {
  if (!Number.isFinite(credit)) return 0;
  const step = curve.step;
  if (!(step > 0)) {
    const reached = curve.direction === 'down' ? credit <= curve.start : credit >= curve.start;
    return reached ? 1 : 0;
  }
  if (curve.direction === 'down') {
    if (credit > curve.start) return 0;
    let tier = 1;
    for (let next = 2; next <= 10000; next += 1) {
      const boundary = rawBoundary(curve, next);
      if (boundary <= 0) break;
      if (credit <= boundary + 1e-9) tier = next;
      else break;
    }
    return tier;
  }
  if (credit + 1e-9 < curve.start) return 0;
  let tier = 1;
  for (let next = 2; next <= 10000; next += 1) {
    if (credit + 1e-9 >= rawBoundary(curve, next)) tier = next;
    else break;
  }
  return tier;
}

export function barForCredit(curve: Curve, credit: number, tier: number): {
  from: number;
  to: number;
  value: number;
} {
  if (!(curve.step > 0)) {
    return { from: 0, to: curve.start, value: credit };
  }
  if (curve.direction === 'down') {
    const from = tier <= 0 ? curve.start + curve.step : rawBoundary(curve, tier);
    const next = rawBoundary(curve, Math.max(tier, 0) + 1);
    const to = next > 0 ? next : from;
    return { from, to, value: credit };
  }
  const from = tier <= 0 ? 0 : rawBoundary(curve, tier);
  const to = rawBoundary(curve, tier + 1);
  return { from, to, value: credit };
}

/** Highest label whose minTier is still at or below the earned tier. */
export function labelForTier(labels: readonly TierLabel[], tier: number): string | null {
  if (tier <= 0) return null;
  let best: TierLabel | null = null;
  for (const row of labels) {
    if (!row.label || row.minTier > tier) continue;
    if (!best || row.minTier >= best.minTier) best = row;
  }
  return best ? best.label : null;
}
