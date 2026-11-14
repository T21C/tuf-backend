import type { Transaction } from 'sequelize';
import { Op } from 'sequelize';
import CurationType from '@/models/curations/CurationType.js';
import { curationTypeRatingBucket, parseCurationFamilyTier, type CurationRatingBucket } from './curationTypeFamilies.js';
import { parseRatingRange } from './RatingUtils.js';

export type CurationRatingPicks = {
  chartTypeId: number | null;
  chartTypeHighId: number | null;
  vfxTypeId: number | null;
  vfxTypeHighId: number | null;
  chartRating?: string | null;
  vfxRating?: string | null;
  miscTypeIds: number[];
};

export type CurationRangeTypeRef = {
  id: number;
  name?: string | null;
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

function emptyPicks(): CurationRatingPicks {
  return {
    chartTypeId: null,
    chartTypeHighId: null,
    vfxTypeId: null,
    vfxTypeHighId: null,
    miscTypeIds: [],
  };
}

function bucketErrorMessage(expectedBucket: CurationRatingBucket, fieldLabel: string): string {
  if (expectedBucket === 'chart') return `${fieldLabel} must be a C or O curation type`;
  if (expectedBucket === 'vfx') return `${fieldLabel} must be a V curation type`;
  return `${fieldLabel} may only include non C/O/V types`;
}

function assertBucket(
  type: CurationRangeTypeRef | undefined,
  expectedBucket: CurationRatingBucket,
  fieldLabel: string,
): void {
  if (curationTypeRatingBucket(type?.name) !== expectedBucket) {
    throw new CurationRatingPickError(400, bucketErrorMessage(expectedBucket, fieldLabel));
  }
}

export function normalizeCurationRange(
  lowId: number | null,
  highId: number | null,
  byId: Map<number, CurationRangeTypeRef>,
  expectedBucket: CurationRatingBucket,
  fieldLabel: string,
): {typeId: number | null; typeHighId: number | null} {
  if (lowId == null && highId == null) {
    return {typeId: null, typeHighId: null};
  }
  if (lowId == null) {
    assertBucket(byId.get(highId as number), expectedBucket, fieldLabel);
    return {typeId: highId, typeHighId: null};
  }
  assertBucket(byId.get(lowId), expectedBucket, fieldLabel);
  if (highId == null || highId === lowId) {
    return {typeId: lowId, typeHighId: null};
  }
  assertBucket(byId.get(highId), expectedBucket, fieldLabel);
  const lowFamily = parseCurationFamilyTier(byId.get(lowId)?.name);
  const highFamily = parseCurationFamilyTier(byId.get(highId)?.name);
  if (!lowFamily || !highFamily || lowFamily.letter !== highFamily.letter) {
    throw new CurationRatingPickError(400, `${fieldLabel} range must stay in the same family`);
  }
  if (lowFamily.tier <= highFamily.tier) {
    return {typeId: lowId, typeHighId: highId};
  }
  return {typeId: highId, typeHighId: lowId};
}

function optionalRatingText(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'string') {
    throw new CurationRatingPickError(400, 'Rating text must be a string');
  }
  return value;
}

function ratingTextEmpty(value: string | null | undefined): boolean {
  return value == null || String(value).trim() === '';
}

export function resolveCurationRatingString(
  raw: string | null | undefined,
  types: Iterable<CurationRangeTypeRef>,
  expectedBucket: CurationRatingBucket,
  fieldLabel: string,
): {typeId: number | null; typeHighId: number | null} {
  const input = String(raw ?? '').trim();
  if (!input) return {typeId: null, typeHighId: null};

  const byName = new Map<string, CurationRangeTypeRef>();
  const byId = new Map<number, CurationRangeTypeRef>();
  for (const type of types) {
    const id = Number(type.id);
    if (!Number.isInteger(id) || id <= 0) continue;
    byId.set(id, type);
    const name = String(type.name ?? '').trim().toUpperCase();
    if (name) byName.set(name, type);
  }

  const parts = parseRatingRange(input, new Set());
  const resolvedIds: number[] = [];
  for (const part of parts) {
    const type = byName.get(part.trim().toUpperCase());
    if (!type) {
      throw new CurationRatingPickError(400, `${fieldLabel} range is invalid`);
    }
    resolvedIds.push(type.id);
  }
  return normalizeCurationRange(
    resolvedIds[0] ?? null,
    resolvedIds[1] ?? null,
    byId,
    expectedBucket,
    fieldLabel,
  );
}

export function parseCurationRatingPicks(body: Record<string, unknown>): CurationRatingPicks {
  return {
    chartTypeId: optionalPositiveInt(body.chartTypeId),
    chartTypeHighId: optionalPositiveInt(body.chartTypeHighId),
    vfxTypeId: optionalPositiveInt(body.vfxTypeId),
    vfxTypeHighId: optionalPositiveInt(body.vfxTypeHighId),
    chartRating: optionalRatingText(body.chartRating),
    vfxRating: optionalRatingText(body.vfxRating),
    miscTypeIds: uniquePositiveInts(body.miscTypeIds),
  };
}

export function picksAreEmpty(picks: CurationRatingPicks): boolean {
  return (
    picks.chartTypeId == null &&
    picks.chartTypeHighId == null &&
    picks.vfxTypeId == null &&
    picks.vfxTypeHighId == null &&
    ratingTextEmpty(picks.chartRating) &&
    ratingTextEmpty(picks.vfxRating) &&
    picks.miscTypeIds.length === 0
  );
}

export function picksFromTypeRows(
  types: Array<{id: number; name?: string | null}>,
): CurationRatingPicks {
  const picks = emptyPicks();
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
    ...(picks.chartTypeHighId != null ? [picks.chartTypeHighId] : []),
    ...(picks.vfxTypeId != null ? [picks.vfxTypeId] : []),
    ...(picks.vfxTypeHighId != null ? [picks.vfxTypeHighId] : []),
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
  const hasRatingText = picks.chartRating != null || picks.vfxRating != null;
  if (ids.length === 0 && !hasRatingText) return picks;

  const rows = await CurationType.findAll({
    ...(hasRatingText ? {} : {where: {id: {[Op.in]: ids}}}),
    attributes: ['id', 'name'],
    ...(transaction ? {transaction} : {}),
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  if (!hasRatingText && rows.length !== ids.length) {
    throw new CurationRatingPickError(400, 'One or more curation types not found');
  }

  const chart = picks.chartRating != null
    ? resolveCurationRatingString(picks.chartRating, rows, 'chart', 'chartRating')
    : normalizeCurationRange(
        picks.chartTypeId,
        picks.chartTypeHighId,
        byId,
        'chart',
        'chartTypeId',
      );
  const vfx = picks.vfxRating != null
    ? resolveCurationRatingString(picks.vfxRating, rows, 'vfx', 'vfxRating')
    : normalizeCurationRange(
        picks.vfxTypeId,
        picks.vfxTypeHighId,
        byId,
        'vfx',
        'vfxTypeId',
      );
  for (const id of picks.miscTypeIds) {
    const type = byId.get(id);
    if (!type) {
      throw new CurationRatingPickError(400, 'One or more curation types not found');
    }
    const bucket = curationTypeRatingBucket(type.name);
    if (bucket !== 'misc') {
      throw new CurationRatingPickError(400, 'miscTypeIds may only include non C/O/V types');
    }
  }
  return {
    chartTypeId: chart.typeId,
    chartTypeHighId: chart.typeHighId,
    vfxTypeId: vfx.typeId,
    vfxTypeHighId: vfx.typeHighId,
    miscTypeIds: picks.miscTypeIds,
  };
}
