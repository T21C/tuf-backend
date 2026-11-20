import { shownRequirement } from '../engine/curve.js';
import type { BadgeDraft } from '../engine/params.js';
import type { StoredBadge } from '../engine/grant.js';
import type { PassFact } from '../engine/evaluate.js';

export type CreditUnit = 'days' | 'keys' | 'perfects' | 'id';

/** Unit of the credit when it is not a plain tally. */
export function creditUnit(expression: string | null | undefined): CreditUnit | null {
  if (!expression) return null;
  if (/\bgap\s*\(/.test(expression)) return 'days';
  if (/\bcurveDown\s*\(\s*min\s*\([\s\S]*\bkeyCount\b/.test(expression)) return 'keys';
  if (/\bcurveDown\s*\(\s*min\s*\([\s\S]*\bperfects\b/.test(expression)) return 'perfects';
  if (/\bresult\s*\([\s\S]*\bmin\s*\([\s\S]*\blevelId\b/.test(expression)) return 'id';
  return null;
}

export type PublicBadge = {
  id: number;
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  purple: boolean;
  earned: boolean;
  secret: boolean;
  manual: boolean;
  tier: number;
  tierLabel: string | null;
  stat: BadgeDraft['display']['stat'];
  unit: CreditUnit | null;
  credit: number | null;
  bar: { from: number; to: number; value: number } | null;
  nextRequirement: number | null;
  confirm: {
    passId: number;
    clear: {
      id: number;
      accuracy: number | null;
      speed: number | null;
      isWorldsFirst: boolean;
      isWorldsFirstPP: boolean;
      isXPerfectMode: boolean;
      judgements: PassFact['judgements'];
      level: { id: number; song: string; artist: string; diffId: number } | null;
    };
  }[];
};

export type ProvingClear = PublicBadge['confirm'][number]['clear'];

export function toPublicBadge(
  def: BadgeDraft,
  state: StoredBadge | null,
  proving: ProvingClear[],
): PublicBadge | null {
  if (!def.id || !def.enabled) return null;
  const tier = state?.tier ?? 0;
  const earned = tier > 0;
  if (def.secret && !earned) return null;
  const bar = state
    ? { from: state.barFrom, to: state.barTo, value: state.barValue }
    : null;
  const confirm = earned && (def.confirm === 'accuracyFull' || def.confirm === 'judgementsFull')
    ? proving.map((clear) => ({ passId: clear.id, clear }))
    : [];
  return {
    id: def.id,
    name: def.name,
    description: def.display.description,
    icon: def.display.icon,
    color: def.display.color,
    purple: def.display.purple,
    earned,
    secret: def.secret,
    manual: def.grant === 'manualLock',
    tier: earned ? tier : 0,
    tierLabel: earned ? state?.tierLabel ?? null : null,
    stat: def.display.stat,
    unit: creditUnit(def.params.expression),
    credit: def.secret && !earned ? null : state?.credit ?? 0,
    bar: def.secret && !earned ? null : bar,
    nextRequirement: def.secret && !earned
      ? null
      : def.reducer === 'chase'
        ? null
        : def.reducer === 'pack' || def.reducer === 'percentOf' || def.reducer === 'coverage' || def.reducer === 'value'
          ? state?.barTo ?? null
          : shownRequirement(def.curve, earned ? tier + 1 : 1),
    confirm,
  };
}
