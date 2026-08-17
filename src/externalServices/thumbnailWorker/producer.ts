import {randomUUID} from 'node:crypto';
import {type JobsOptions} from 'bullmq';
import {
  addThumbnailRenderJob,
  getThumbnailRenderQueue,
  thumbnailRenderJobId,
} from './queue.js';
import {
  assertSafeFileName,
  ensureThumbnailWorkerDirectories,
  writeHtmlInputAtomically,
} from './fileStore.js';
import type {ThumbnailEntityType} from './contracts.js';
import {THUMBNAIL_WORKER_CONFIG} from './config.js';

export class ThumbnailQueueUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ThumbnailQueueUnavailableError';
  }
}

export interface EnqueueThumbnailRenderInput {
  entityType: ThumbnailEntityType;
  entityId: string | number;
  html: string;
  outputFileName: string;
  width: number;
  height: number;
  requestId?: string;
}

export async function enqueueThumbnailRender(
  input: EnqueueThumbnailRenderInput,
  jobOptions: JobsOptions = {},
) {
  try {
    assertSafeFileName(input.outputFileName, '.png');
    const queue = getThumbnailRenderQueue();
    const jobId = thumbnailRenderJobId(input.outputFileName);
    const existingJob = await queue.getJob(jobId);
    if (existingJob) return existingJob;

    const [waiting, delayed] = await Promise.all([
      queue.getWaitingCount(),
      queue.getDelayedCount(),
    ]);
    const backlog = waiting + delayed;
    if (backlog >= THUMBNAIL_WORKER_CONFIG.maxWaitingJobs) {
      throw new Error(`Thumbnail render queue is full (${backlog} waiting or delayed)`);
    }

    await ensureThumbnailWorkerDirectories();
    const inputFileName = `${input.outputFileName.slice(0, -4)}.html`;
    await writeHtmlInputAtomically(inputFileName, input.html);

    return await addThumbnailRenderJob(
      {
        version: 1,
        requestId: input.requestId || randomUUID(),
        entityType: input.entityType,
        entityId: String(input.entityId),
        inputFileName,
        outputFileName: input.outputFileName,
        width: input.width,
        height: input.height,
        enqueuedAt: new Date().toISOString(),
      },
      jobOptions,
    );
  } catch (error) {
    if (error instanceof ThumbnailQueueUnavailableError) throw error;
    throw new ThumbnailQueueUnavailableError('Thumbnail render queue is unavailable', {
      cause: error,
    });
  }
}
