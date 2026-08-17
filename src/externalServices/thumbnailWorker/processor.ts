import type {Job} from 'bullmq';
import {logger} from '@/server/services/core/LoggerService.js';
import type {ThumbnailRenderJobData, ThumbnailRenderJobResult} from './contracts.js';
import {
  readHtmlInput,
  removeHtmlInput,
  writePngOutputAtomically,
} from './fileStore.js';
import {puppeteerRenderer} from './puppeteerRenderer.js';
import {THUMBNAIL_WORKER_CONFIG} from './config.js';

function assertValidDimensions(width: number, height: number): void {
  for (const [name, value] of Object.entries({width, height})) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > THUMBNAIL_WORKER_CONFIG.maxDimension) {
      throw new Error(
        `Invalid thumbnail ${name} ${value}; expected an integer from 1 to ${THUMBNAIL_WORKER_CONFIG.maxDimension}`,
      );
    }
  }
}

export async function processThumbnailRenderJob(
  job: Job<ThumbnailRenderJobData, ThumbnailRenderJobResult>,
): Promise<ThumbnailRenderJobResult> {
  if (job.name !== 'render-html-to-png') throw new Error(`Unsupported job name: ${job.name}`);
  if (job.data.version !== 1) throw new Error(`Unsupported job version: ${job.data.version}`);
  assertValidDimensions(job.data.width, job.data.height);

  const startedAt = Date.now();
  const fields = {
    jobId: job.id,
    requestId: job.data.requestId,
    entityType: job.data.entityType,
    entityId: job.data.entityId,
    attempt: job.attemptsMade + 1,
  };
  logger.info('[thumbnail-worker] render started', fields);

  const html = await readHtmlInput(job.data.inputFileName);
  const png = await puppeteerRenderer.render(html, job.data.width, job.data.height);
  await writePngOutputAtomically(job.data.outputFileName, png);
  await removeHtmlInput(job.data.inputFileName);

  const result = {
    outputFileName: job.data.outputFileName,
    bytes: png.byteLength,
    renderDurationMs: Date.now() - startedAt,
    completedAt: new Date().toISOString(),
  };
  logger.info('[thumbnail-worker] render completed', {...fields, ...result});
  return result;
}
