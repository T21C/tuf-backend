import { createHash } from 'node:crypto';
import { subscribeStream, CDC_STREAM_FIELDS } from '@/server/services/eventBus/index.js';
import { readInternalTokens } from './internalTokens.js';

/** Failed delivery stays pending in the existing committed CDC stream consumer. */
export function startAutoSubmissionLevelChanges(): (() => Promise<void>) | undefined {
  const base = process.env.AUTO_SUBMISSION_API_URL;
  const tokens = readInternalTokens();
  if (!base || !tokens) return;
  const { stop } = subscribeStream({
    stream: 'cdc:levels',
    consumerGroup: 'auto-submission-level-changes',
    partitionKey: fields => {
      const row = JSON.parse(fields[CDC_STREAM_FIELDS.after] || fields[CDC_STREAM_FIELDS.before] || 'null');
      return String(row?.id ?? 'level');
    },
    handle: async fields => {
      const before = JSON.parse(fields[CDC_STREAM_FIELDS.before] || 'null') as Record<string, unknown> | null;
      const after = JSON.parse(fields[CDC_STREAM_FIELDS.after] || 'null') as Record<string, unknown> | null;
      const id = Number(after?.id ?? before?.id);
      if (!Number.isSafeInteger(id) || id <= 0) return;
      const relevant = ['fileId', 'diffId', 'isHidden', 'isDeleted', 'dlLink', 'baseScore'];
      if (before && after && relevant.every(key => before[key] === after[key])) return;
      const eventId = createHash('sha256').update(JSON.stringify(fields)).digest('hex');
      const response = await fetch(new URL(`/internal/tuf/levels/${id}/changed`, base), {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens.outgoing}` },
        body: JSON.stringify({ event_id: eventId }),
      });
      if (!response.ok) throw new Error(`Auto submission change delivery returned ${response.status}`);
    },
  });
  return async () => { await stop(); };
}
