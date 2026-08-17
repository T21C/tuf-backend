import 'dotenv/config';
import '@/observability/instrument.js';
import express from 'express';
import {createServer} from 'node:http';
import {Worker} from 'bullmq';
import {logger} from '@/server/services/core/LoggerService.js';
import {registerGlobalProcessHandlers} from '@/server/bootstrap/processHandlers.js';
import {registerShutdownStep} from '@/server/bootstrap/shutdownCoordinator.js';
import {setTerminalServiceTitle} from '@/misc/utils/terminalTitle.js';
import {THUMBNAIL_WORKER_CONFIG} from './config.js';
import {createBullMqConnection} from './redisConnection.js';
import {ensureThumbnailWorkerDirectories, removeHtmlInput} from './fileStore.js';
import {processThumbnailRenderJob} from './processor.js';
import {puppeteerRenderer} from './puppeteerRenderer.js';
import type {ThumbnailRenderJobData, ThumbnailRenderJobResult} from './contracts.js';

setTerminalServiceTitle('TUF Thumbnail Worker');
registerGlobalProcessHandlers();
await ensureThumbnailWorkerDirectories();

const state = {
  ready: false,
  redisReady: false,
  activeJobs: 0,
  completedJobs: 0,
  failedJobs: 0,
  lastCompletedAt: null as string | null,
  lastFailedAt: null as string | null,
};

const worker = new Worker<ThumbnailRenderJobData, ThumbnailRenderJobResult>(
  THUMBNAIL_WORKER_CONFIG.queueName,
  processThumbnailRenderJob,
  {
    connection: createBullMqConnection(),
    prefix: THUMBNAIL_WORKER_CONFIG.queuePrefix,
    concurrency: THUMBNAIL_WORKER_CONFIG.concurrency,
    autorun: false,
  },
);

worker.on('ready', () => {
  state.redisReady = true;
});
worker.on('active', () => state.activeJobs++);
worker.on('completed', () => {
  state.activeJobs = Math.max(0, state.activeJobs - 1);
  state.completedJobs++;
  state.lastCompletedAt = new Date().toISOString();
});
worker.on('failed', async (job, error) => {
  state.activeJobs = Math.max(0, state.activeJobs - 1);
  state.failedJobs++;
  state.lastFailedAt = new Date().toISOString();
  logger.error('[thumbnail-worker] job failed', {
    jobId: job?.id,
    requestId: job?.data.requestId,
    attemptsMade: job?.attemptsMade,
    error: error.message,
  });

  // Preserve the input between BullMQ attempts; clean it only after the final one.
  const attempts = job?.opts.attempts || 1;
  if (job && job.attemptsMade >= attempts) {
    await removeHtmlInput(job.data.inputFileName).catch(cleanupError => {
      logger.warn('[thumbnail-worker] failed input cleanup failed', cleanupError);
    });
  }
});
worker.on('error', error => {
  state.redisReady = false;
  logger.error('[thumbnail-worker] worker error', error);
});

const healthApp = express();
healthApp.get('/health', (_req, res) => {
  const ok = state.ready && state.redisReady && worker.isRunning();
  res.status(ok ? 200 : 503).json({
    ok,
    service: 'thumbnail-worker',
    queue: THUMBNAIL_WORKER_CONFIG.queueName,
    concurrency: THUMBNAIL_WORKER_CONFIG.concurrency,
    ...state,
  });
});

const healthServer = createServer(healthApp);
await new Promise<void>((resolve, reject) => {
  healthServer.once('error', reject);
  healthServer.listen(
    THUMBNAIL_WORKER_CONFIG.healthPort,
    THUMBNAIL_WORKER_CONFIG.bindAddress,
    () => resolve(),
  );
});

const workerRun = worker.run();
await worker.waitUntilReady();
state.ready = true;
state.redisReady = true;
logger.info('[thumbnail-worker] ready', {
  queue: THUMBNAIL_WORKER_CONFIG.queueName,
  concurrency: THUMBNAIL_WORKER_CONFIG.concurrency,
  health: `http://${THUMBNAIL_WORKER_CONFIG.bindAddress}:${THUMBNAIL_WORKER_CONFIG.healthPort}/health`,
});

registerShutdownStep({
  name: 'thumbnail-worker',
  priority: 40,
  fn: async () => {
    state.ready = false;
    await worker.close(false);
    await workerRun.catch(() => undefined);
  },
});
registerShutdownStep({
  name: 'thumbnail-worker-browser',
  priority: 50,
  fn: () => puppeteerRenderer.close(),
});
registerShutdownStep({
  name: 'thumbnail-worker-health-server',
  priority: 60,
  fn: () => new Promise<void>((resolve, reject) => {
    healthServer.close(error => error ? reject(error) : resolve());
  }),
});
