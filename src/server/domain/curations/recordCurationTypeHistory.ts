import type { Transaction } from 'sequelize';
import LevelCurationHistory from '@/models/levels/LevelCurationHistory.js';
import { curationTypeIdSetsEqual } from '@/misc/utils/data/curationTypeFamilies.js';

export function normalizeCurationTypeIds(ids: readonly unknown[] | null | undefined): number[] {
  if (!Array.isArray(ids)) return [];
  const out: number[] = [];
  const seen = new Set<number>();
  for (const id of ids) {
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0 || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

export async function recordCurationTypeChange(args: {
  levelId: number;
  previousTypeIds: readonly unknown[];
  newTypeIds: readonly unknown[];
  changedBy: string | null;
  transaction?: Transaction;
}): Promise<void> {
  const previousTypeIds = normalizeCurationTypeIds(args.previousTypeIds);
  const newTypeIds = normalizeCurationTypeIds(args.newTypeIds);
  if (curationTypeIdSetsEqual(previousTypeIds, newTypeIds)) return;

  await LevelCurationHistory.create(
    {
      levelId: args.levelId,
      previousTypeIds,
      newTypeIds,
      changedBy: args.changedBy,
      createdAt: new Date(),
    },
    { transaction: args.transaction },
  );
}
