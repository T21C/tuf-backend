import { parseValueExpr, valueExprNames } from './valueExpr.js';
import type { BadgeDraft } from './params.js';

export type BadgeInterest = 'ownerPass' | 'chartWorld' | 'catalog' | 'pack' | 'creator';

export type InterestSlice = 'hotPlayer' | 'hotCreator' | 'chartWorld' | 'catalog' | 'pack';

const WORLD_VALUE_NAMES = new Set(['nth', 'lead', 'shared', 'first']);

export function badgeInterests(def: BadgeDraft): Set<BadgeInterest> {
  const tags = new Set<BadgeInterest>();
  if (def.audience === 'creator') tags.add('creator');

  switch (def.reducer) {
    case 'record':
    case 'nthClearer':
      tags.add('chartWorld');
      break;
    case 'coverage':
    case 'percentOf':
      tags.add('catalog');
      break;
    case 'pack':
      tags.add('pack');
      break;
    case 'gap':
    case 'threshold':
    case 'sequence':
    case 'chase':
    case 'best':
      tags.add('ownerPass');
      break;
    case 'pattern':
    case 'manual':
      tags.add('ownerPass');
      if (def.params.sharedAccuracy || def.params.pattern?.sharedAccuracy) tags.add('chartWorld');
      break;
    case 'value':
      addValueInterests(def, tags);
      break;
    default:
      tags.add('ownerPass');
  }

  if (def.audience === 'player' && tags.size === 0) tags.add('ownerPass');
  if (def.audience === 'creator' && tags.size === 1 && tags.has('creator')) tags.add('ownerPass');
  return tags;
}

function addValueInterests(def: BadgeDraft, tags: Set<BadgeInterest>): void {
  const expression = def.params.expression || '';
  const parsed = parseValueExpr(expression);
  const names = parsed.ok ? valueExprNames(parsed.ast) : new Set<string>();
  if ([...WORLD_VALUE_NAMES].some((name) => names.has(name))) {
    tags.add('chartWorld');
  }
  if (names.has('difficulty') || names.has('prefix') || names.has('chase')) tags.add('catalog');
  if (names.has('pack') || names.has('complete')) tags.add('pack');
  if (names.has('mine')) tags.add('creator');
  if (
    names.has('clears')
    || names.has('sequence')
    || names.has('consecutive')
    || names.has('gap')
    || names.has('count')
    || names.has('maxCount')
    || names.has('maxGroup')
    || names.has('blocks')
    || names.has('chase')
    || names.has('levels')
  ) {
    tags.add('ownerPass');
  }
  if (tags.size === 0 || (tags.size === 1 && tags.has('creator'))) tags.add('ownerPass');
}

export function needsWorld(def: BadgeDraft): boolean {
  return badgeInterests(def).has('chartWorld');
}

export function needsGlobalWorld(def: BadgeDraft): boolean {
  return def.reducer === 'record' || def.reducer === 'nthClearer';
}

export function defMatchesSlice(def: BadgeDraft, slice: InterestSlice): boolean {
  const tags = badgeInterests(def);
  switch (slice) {
    case 'hotPlayer':
      return def.audience === 'player' && (tags.has('ownerPass') || tags.has('catalog') || tags.has('pack'));
    case 'hotCreator':
      return def.audience === 'creator';
    case 'chartWorld':
      return tags.has('chartWorld');
    case 'catalog':
      return tags.has('catalog');
    case 'pack':
      return tags.has('pack');
    default:
      return true;
  }
}

export function packDefMatches(def: BadgeDraft, packId: number | null): boolean {
  if (!defMatchesSlice(def, 'pack')) return false;
  if (packId == null) return true;
  if (def.reducer === 'pack') return true;
  return def.params.packId == null || Number(def.params.packId) === packId;
}
