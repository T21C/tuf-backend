import { sseManager, SSE_SOURCES } from '@/misc/utils/server/sse.js';
import { logger } from '@/server/services/core/LoggerService.js';

export type SubmissionQueueChange = {
  kind: 'level' | 'pass';
  id: number;
  change: 'created' | 'locked' | 'unlocked' | 'removed';
  isLocked?: boolean;
};

export function broadcastSubmissionQueueChange(change: SubmissionQueueChange): void {
  try {
    sseManager.broadcastToSources([SSE_SOURCES.submission], {
      type: 'submission.queue.changed',
      data: change,
    });
  } catch (err) {
    logger.warn('[submissionQueue] SSE broadcast failed', err);
  }
}
