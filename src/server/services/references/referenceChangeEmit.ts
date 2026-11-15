import type {Transaction} from 'sequelize';
import {OutboxService} from '@/server/services/outbox/OutboxService.js';
import {OUTBOX_EVENT_TYPES} from '@/server/services/outbox/events.js';
import {
  referenceChangeDedupKey,
  type ReferenceChangeKind,
} from './referenceChange.js';

export async function emitReferenceChanged(args: {
  kind: ReferenceChangeKind;
  levelId: number;
  difficultyIds: number[];
  actorId?: string | null;
  type?: string | null;
  previousType?: string | null;
  previousDiffId?: number | null;
  isHidden?: boolean;
  fileId?: string | null;
  dlLink?: string | null;
  diffId?: number | null;
  transaction?: Transaction;
}): Promise<void> {
  const levelId = Number(args.levelId);
  if (!Number.isInteger(levelId) || levelId <= 0) return;
  const difficultyIds = [
    ...new Set(
      (args.difficultyIds ?? []).filter((id) => Number.isInteger(id) && id > 0),
    ),
  ];
  if (!difficultyIds.length) return;

  const dedupKey = referenceChangeDedupKey({
    kind: args.kind,
    levelId,
    difficultyId: difficultyIds.length === 1 ? difficultyIds[0] : null,
    type: args.type,
    fileId: args.fileId,
    dlLink: args.dlLink,
    diffId: args.diffId,
    isHidden: args.isHidden,
  });

  await OutboxService.emit(OUTBOX_EVENT_TYPES.ReferenceChanged, {
    aggregate: 'level',
    aggregateId: String(levelId),
    payload: {
      kind: args.kind,
      levelId,
      difficultyIds,
      actorId: args.actorId ?? null,
      type: args.type ?? null,
      previousType: args.previousType ?? null,
      previousDiffId: args.previousDiffId ?? null,
      isHidden: args.isHidden,
      fileId: args.fileId ?? null,
      dlLink: args.dlLink ?? null,
      diffId: args.diffId ?? null,
    },
    dedupKey,
    transaction: args.transaction,
  });
}
