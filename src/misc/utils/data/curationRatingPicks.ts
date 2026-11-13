import type { Transaction } from 'sequelize';
import { Op } from 'sequelize';
import CurationType from '@/models/curations/CurationType.js';
import { curationTypeRatingBucket } from './curationTypeFamilies.js';

export type CurationRatingPicks = {
  chartTypeId: number | null;
  vfxTypeId: number | null;
  miscTypeIds: number[];
};

export class CurationRatingPickError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'CurationRatingPickError';
  }
}

function optionalPositiveInt(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new CurationRatingPickError(400, 'Type ids must be positive integers');
  }
  return n;
}

function uniquePositiveInts(value: unknown): number[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new CurationRatingPickError(400, 'miscTypeIds must be an array');
  }
  const out: number[] = [];
  const seen = new Set<number>();
  for (const item of value) {
    const n = optionalPositiveInt(item);
    if (n == null || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

export function parseCurationRatingPicks(body: Record<string, unknown>): CurationRatingPicks {
  return {
    chartTypeId: optionalPositiveInt(body.chartTypeId),
    vfxTypeId: optionalPositiveInt(body.vfxTypeId),
    miscTypeIds: uniquePositiveInts(body.miscTypeIds),
  };
}

export function picksAreEmpty(picks: CurationRatingPicks): boolean {
  return picks.chartTypeId == null && picks.vfxTypeId == null && picks.miscTypeIds.length === 0;
}

export function picksFromTypeRows(
  types: Array<{id: number; name?: string | null}>,
): CurationRatingPicks {
  const picks: CurationRatingPicks = {
    chartTypeId: null,
    vfxTypeId: null,
    miscTypeIds: [],
  };
  for (const type of types) {
    const id = Number(type?.id);
    if (!Number.isInteger(id) || id <= 0) continue;
    const bucket = curationTypeRatingBucket(type?.name);
    if (bucket === 'chart' && picks.chartTypeId == null) {
      picks.chartTypeId = id;
    } else if (bucket === 'vfx' && picks.vfxTypeId == null) {
      picks.vfxTypeId = id;
    } else if (bucket === 'misc' && !picks.miscTypeIds.includes(id)) {
      picks.miscTypeIds.push(id);
    }
  }
  return picks;
}

export function collectedTypeIds(picks: CurationRatingPicks): number[] {
  const ids = [
    ...(picks.chartTypeId != null ? [picks.chartTypeId] : []),
    ...(picks.vfxTypeId != null ? [picks.vfxTypeId] : []),
    ...picks.miscTypeIds,
  ];
  return [...new Set(ids)];
}

export function normalizeMiscTypeIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  const seen = new Set<number>();
  for (const item of value) {
    const n = Number(item);
    if (!Number.isInteger(n) || n <= 0 || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

export async function assertCurationRatingPicks(
  picks: CurationRatingPicks,
  transaction?: Transaction,
): Promise<CurationRatingPicks> {
  const ids = collectedTypeIds(picks);
  if (ids.length === 0) return picks;

  const rows = await CurationType.findAll({
    where: {id: {[Op.in]: ids}},
    attributes: ['id', 'name'],
    ...(transaction ? {transaction} : {}),
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  if (rows.length !== ids.length) {
    throw new CurationRatingPickError(400, 'One or more curation types not found');
  }

  if (picks.chartTypeId != null) {
    const bucket = curationTypeRatingBucket(byId.get(picks.chartTypeId)?.name);
    if (bucket !== 'chart') {
      throw new CurationRatingPickError(400, 'chartTypeId must be a C or O curation type');
    }
  }
  if (picks.vfxTypeId != null) {
    const bucket = curationTypeRatingBucket(byId.get(picks.vfxTypeId)?.name);
    if (bucket !== 'vfx') {
      throw new CurationRatingPickError(400, 'vfxTypeId must be a V curation type');
    }
  }
  for (const id of picks.miscTypeIds) {
    const bucket = curationTypeRatingBucket(byId.get(id)?.name);
    if (bucket !== 'misc') {
      throw new CurationRatingPickError(400, 'miscTypeIds may only include non C/O/V types');
    }
  }
  return picks;
}
