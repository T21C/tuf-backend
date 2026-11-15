import {subscribeStream, CDC_STREAM_FIELDS} from '@/server/services/eventBus/index.js';
import Reference from '@/models/levels/References.js';
import {logger} from '@/server/services/core/LoggerService.js';
import {referenceChartChangeKind} from './referenceChange.js';
import {emitReferenceChanged} from './referenceChangeEmit.js';

function parseRow(raw: string): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown> | null;
  } catch {
    return null;
  }
}

export function startReferenceLevelChangeDispatcher(): {stop: () => Promise<void>} {
  const {stop} = subscribeStream({
    stream: 'cdc:levels',
    consumerGroup: 'reference-level-changes',
    partitionKey: (fields) => {
      const row = parseRow(fields[CDC_STREAM_FIELDS.after] || fields[CDC_STREAM_FIELDS.before] || '');
      return String(row?.id ?? 'level');
    },
    handle: async (fields) => {
      const before = parseRow(fields[CDC_STREAM_FIELDS.before] || '');
      const after = parseRow(fields[CDC_STREAM_FIELDS.after] || '');
      const kind = referenceChartChangeKind(before, after);
      if (!kind) return;

      const id = Number(after?.id ?? before?.id);
      if (!Number.isSafeInteger(id) || id <= 0) return;

      const refs = await Reference.findAll({
        attributes: ['difficultyId'],
        where: {levelId: id},
      });
      const difficultyIds = [
        ...new Set(
          refs
            .map((row) => Number(row.difficultyId))
            .filter((diffId) => Number.isInteger(diffId) && diffId > 0),
        ),
      ];
      if (!difficultyIds.length) return;

      await emitReferenceChanged({
        kind,
        levelId: id,
        difficultyIds,
        isHidden: after ? Boolean(after.isHidden) : undefined,
        fileId: after?.fileId != null ? String(after.fileId) : before?.fileId != null ? String(before.fileId) : null,
        dlLink: after?.dlLink != null ? String(after.dlLink) : before?.dlLink != null ? String(before.dlLink) : null,
        diffId: Number(after?.diffId ?? before?.diffId) || null,
        previousDiffId: before?.diffId != null ? Number(before.diffId) : null,
      });
    },
  });

  logger.info('[reference-level-changes] Dispatcher subscribed');
  return {stop};
}
