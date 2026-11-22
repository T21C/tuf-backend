export type OwnerKind = 'player' | 'creator';

export function parseOwnerKind(value: unknown): OwnerKind | null {
  return value === 'player' || value === 'creator' ? value : null;
}

export function parseOwnerBound(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return null;
  return n;
}

export type OwnerBounds = { min: number; max: number };

export function parseOwnerBounds(row?: Record<string, unknown> | { minId?: unknown; maxId?: unknown } | null): OwnerBounds | null {
  const src = row && typeof row === 'object' ? row as Record<string, unknown> : {};
  const min = Math.floor(Number(src.minId ?? src.minid ?? src.min));
  const max = Math.floor(Number(src.maxId ?? src.maxid ?? src.max));
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 1 || max < min) return null;
  return { min, max };
}

export function ownerRangeFrom(values: {
  ownerFrom?: unknown;
  ownerTo?: unknown;
  startFrom?: unknown;
}): { ownerFrom: number | null; ownerTo: number | null } {
  const ownerFrom = parseOwnerBound(values.ownerFrom ?? values.startFrom);
  const ownerTo = parseOwnerBound(values.ownerTo);
  if (ownerFrom != null && ownerTo != null && ownerTo < ownerFrom) {
    return { ownerFrom, ownerTo: ownerFrom };
  }
  return { ownerFrom, ownerTo };
}

export function clampOwnerRange(
  range: { ownerFrom: number | null; ownerTo: number | null },
  bounds: OwnerBounds | null,
): { ownerFrom: number | null; ownerTo: number | null } {
  if (!bounds) return range;
  const clamp = (id: number | null): number | null => {
    if (id == null) return null;
    return Math.min(bounds.max, Math.max(bounds.min, id));
  };
  return ownerRangeFrom({
    ownerFrom: clamp(range.ownerFrom),
    ownerTo: clamp(range.ownerTo),
  });
}

export function inOwnerRange(id: number, from: number | null, to: number | null): boolean {
  if (from != null && id < from) return false;
  if (to != null && id > to) return false;
  return true;
}

export function compareOwners(
  left: { audience: 'player' | 'creator'; id: number },
  right: { audience: 'player' | 'creator'; id: number },
): number {
  const rank = (item: { audience: 'player' | 'creator' }) => (item.audience === 'player' ? 0 : 1);
  return rank(left) - rank(right) || left.id - right.id;
}
