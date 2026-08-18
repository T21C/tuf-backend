import {Queue, QueueEvents, type JobsOptions} from 'bullmq';
import {logger} from '@/server/services/core/LoggerService.js';
import {THUMBNAIL_WORKER_CONFIG} from './config.js';
import {createBullMqConnection} from './redisConnection.js';
import {
  THUMBNAIL_RENDER_JOB_NAME,
  type ThumbnailRenderJobData,
  type ThumbnailRenderJobResult,
} from './contracts.js';
import {registerShutdownStep} from '@/server/bootstrap/shutdownCoordinator.js';
import {thumbnailRenderJobId} from './producerHelpers.js';

let queue: Queue<ThumbnailRenderJobData, ThumbnailRenderJobResult> | null = null;
let queueEvents: QueueEvents | null = null;

export function getThumbnailRenderQueue(): Queue<ThumbnailRenderJobData, ThumbnailRenderJobResult> {
  if (!queue) {
    queue = new Queue(THUMBNAIL_WORKER_CONFIG.queueName, {
      connection: createBullMqConnection(),
      prefix: THUMBNAIL_WORKER_CONFIG.queuePrefix,
      defaultJobOptions: {
        attempts: THUMBNAIL_WORKER_CONFIG.attempts,
        backoff: {type: 'exponential', delay: 1000},
        removeOnComplete: true,
        removeOnFail: true,
      },
    });
    queue.on('error', error => logger.error('[thumbnail-queue] queue error', error));
  }
  return queue;
}

export function getThumbnailQueueEvents(): QueueEvents {
  if (!queueEvents) {
    queueEvents = new QueueEvents(THUMBNAIL_WORKER_CONFIG.queueName, {
      connection: createBullMqConnection(),
      prefix: THUMBNAIL_WORKER_CONFIG.queuePrefix,
    });
    queueEvents.on('error', error => logger.error('[thumbnail-queue] events error', error));
  }
  return queueEvents;
}

export async function addThumbnailRenderJob(
  data: ThumbnailRenderJobData,
  options: JobsOptions = {},
) {
  return getThumbnailRenderQueue().add(THUMBNAIL_RENDER_JOB_NAME, data, {
    jobId: thumbnailRenderJobId(data.outputFileName),
    ...options,
  });
}

export {thumbnailRenderJobId} from './producerHelpers.js';

export async function closeThumbnailQueueClients(): Promise<void> {
  const clients = [queueEvents?.close(), queue?.close()].filter(Boolean) as Promise<void>[];
  await Promise.allSettled(clients);
  queueEvents = null;
  queue = null;
}

registerShutdownStep({
  name: 'thumbnail-queue-clients',
  priority: 80,
  fn: () => closeThumbnailQueueClients(),
});
