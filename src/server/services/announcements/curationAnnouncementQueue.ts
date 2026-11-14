import {Op, type Transaction} from 'sequelize';
import CurationAnnouncementQueue, {
  type CurationAnnouncementKind,
} from '@/models/curations/CurationAnnouncementQueue.js';
import CurationType from '@/models/curations/CurationType.js';
import {
  announcedCurationTypeIds,
  shouldAnnounceCurationTypeChange,
} from '@/misc/utils/data/curationTypeFamilies.js';

function asIdList(value: unknown): number[] {
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

async function announcedIdsFor(
  ids: number[],
  transaction?: Transaction,
): Promise<number[]> {
  if (ids.length === 0) return [];
  const rows = await CurationType.findAll({
    where: {id: {[Op.in]: ids}},
    attributes: ['id', 'name'],
    transaction,
  });
  return announcedCurationTypeIds(ids, new Map(rows.map((row) => [row.id, row])));
}

export async function enqueueCurationAnnouncement(args: {
  levelId: number;
  kind: CurationAnnouncementKind;
  beforeTypeIds: number[];
  afterTypeIds: number[];
  enqueuedBy?: string | null;
  transaction?: Transaction;
}): Promise<CurationAnnouncementQueue | null> {
  const beforeTypeIds = await announcedIdsFor(asIdList(args.beforeTypeIds), args.transaction);
  const afterTypeIds = await announcedIdsFor(asIdList(args.afterTypeIds), args.transaction);
  if (!shouldAnnounceCurationTypeChange(beforeTypeIds, afterTypeIds)) {
    const existingSilent = await CurationAnnouncementQueue.findOne({
      where: {levelId: args.levelId, status: 'PENDING'},
      transaction: args.transaction,
      lock: args.transaction ? args.transaction.LOCK.UPDATE : undefined,
    });
    if (existingSilent) {
      await existingSilent.update(
        {status: 'SKIPPED', pendingUniqueKey: null},
        {transaction: args.transaction},
      );
      return existingSilent;
    }
    return null;
  }

  const existing = await CurationAnnouncementQueue.findOne({
    where: {levelId: args.levelId, status: 'PENDING'},
    transaction: args.transaction,
    lock: args.transaction ? args.transaction.LOCK.UPDATE : undefined,
  });

  if (existing) {
    const mergedKind =
      existing.kind === 'NEW' || args.kind === 'NEW' ? 'NEW' : 'RERATE';
    const mergedBefore = await announcedIdsFor(
      asIdList(existing.beforeTypeIds),
      args.transaction,
    );
    if (!shouldAnnounceCurationTypeChange(mergedBefore, afterTypeIds)) {
      await existing.update(
        {status: 'SKIPPED', pendingUniqueKey: null},
        {transaction: args.transaction},
      );
      return existing;
    }
    await existing.update(
      {
        kind: mergedKind,
        beforeTypeIds: mergedBefore,
        afterTypeIds,
        enqueuedBy: args.enqueuedBy ?? existing.enqueuedBy,
      },
      {transaction: args.transaction},
    );
    return existing;
  }

  return CurationAnnouncementQueue.create(
    {
      levelId: args.levelId,
      kind: args.kind,
      beforeTypeIds,
      afterTypeIds,
      status: 'PENDING',
      pendingUniqueKey: args.levelId,
      enqueuedBy: args.enqueuedBy ?? null,
    },
    {transaction: args.transaction},
  );
}

export async function markCurationQueueRowsAnnounced(
  queueRowIds: number[],
  transaction?: Transaction,
): Promise<void> {
  if (queueRowIds.length === 0) return;
  await CurationAnnouncementQueue.update(
    {
      status: 'ANNOUNCED',
      pendingUniqueKey: null,
      announcedAt: new Date(),
    },
    {
      where: {id: queueRowIds, status: 'PENDING'},
      transaction,
    },
  );
}

export async function markCurationQueueRowsSkipped(queueRowIds: number[]): Promise<void> {
  if (queueRowIds.length === 0) return;
  await CurationAnnouncementQueue.update(
    {
      status: 'SKIPPED',
      pendingUniqueKey: null,
    },
    {where: {id: queueRowIds, status: 'PENDING'}},
  );
}
