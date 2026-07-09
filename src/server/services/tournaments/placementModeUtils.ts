import type {
  TournamentAttributes,
  TournamentPlacementMode,
  TournamentCardLayout,
} from '@/models/tournaments/Tournament.js';
import type {PlacementRowMode} from '@/models/tournaments/TournamentPlacement.js';

export const DEFAULT_CREDIT_ROLE_FILTER = ['charter', 'vfxer'] as const;
export const UNSERIESED_SORT_WEIGHT = 100;

export function normalizeCreditRoleFilter(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    return [...DEFAULT_CREDIT_ROLE_FILTER];
  }
  return value.map(String);
}

export function resolveEffectiveRowMode(
  placementRowMode: PlacementRowMode | null,
  tournamentMode: TournamentPlacementMode,
): PlacementRowMode {
  return placementRowMode ?? tournamentMode;
}

export function resolveEffectiveCardLayout(
  rowLayout: TournamentCardLayout | null | undefined,
  tournament: Pick<TournamentAttributes, 'cardLayoutDefault'>,
  seriesLayout: TournamentCardLayout | null | undefined,
  effectiveRowMode: PlacementRowMode,
  hasLevelEvidence: boolean,
): TournamentCardLayout {
  const candidate = rowLayout ?? tournament.cardLayoutDefault ?? seriesLayout ?? 'classic';
  const allowed = allowedLayoutsForRow(effectiveRowMode, hasLevelEvidence);
  if (allowed.includes(candidate)) return candidate;
  return allowed[0] ?? 'classic';
}

export function allowedLayoutsForRow(
  effectiveRowMode: PlacementRowMode,
  hasLevelEvidence: boolean,
): TournamentCardLayout[] {
  if (effectiveRowMode === 'level') return ['levelStyle'];
  if (hasLevelEvidence) return ['evidence'];
  return ['classic'];
}

export function normalizeCreditedCreatorIds(value: unknown): number[] | null {
  if (value == null) return null;
  if (!Array.isArray(value)) return null;
  const ids = [...new Set(value.map(Number).filter(n => Number.isFinite(n) && n > 0))];
  return ids.length ? ids : null;
}

export function hasExplicitRecipientFilter(ids: number[] | null | undefined): boolean {
  return Array.isArray(ids) && ids.length > 0;
}
