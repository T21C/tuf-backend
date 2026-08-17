import path from 'node:path';

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function renderMode(): 'local' | 'queue' {
  const value = process.env.THUMBNAIL_RENDER_MODE?.trim().toLowerCase() || 'local';
  if (value !== 'local' && value !== 'queue') {
    throw new Error('THUMBNAIL_RENDER_MODE must be local or queue');
  }
  return value;
}

const cachePath = process.env.CACHE_PATH || path.join(process.cwd(), 'cache');
const queueName = process.env.THUMBNAIL_QUEUE_NAME?.trim() || 'tuf-thumbnail-render-v1';
const queuePrefix = process.env.THUMBNAIL_QUEUE_PREFIX?.trim() || 'tuf';
const QUEUE_TOKEN = /^[A-Za-z0-9_-]+$/;

// BullMQ uses punctuation as internal key separators. Keeping both values to a
// conservative token also makes production/canary namespace review unambiguous.
if (!QUEUE_TOKEN.test(queueName)) {
  throw new Error('THUMBNAIL_QUEUE_NAME contains invalid characters');
}
if (!QUEUE_TOKEN.test(queuePrefix)) {
  throw new Error('THUMBNAIL_QUEUE_PREFIX contains invalid characters');
}

export const THUMBNAIL_WORKER_CONFIG = Object.freeze({
  renderMode: renderMode(),
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  queueName,
  queuePrefix,
  bindAddress: process.env.THUMBNAIL_WORKER_BIND_ADDRESS?.trim() || '127.0.0.1',
  healthPort: positiveInteger('THUMBNAIL_WORKER_PORT', 3891),
  concurrency: positiveInteger('THUMBNAIL_WORKER_CONCURRENCY', 1),
  attempts: positiveInteger('THUMBNAIL_JOB_ATTEMPTS', 2),
  maxHtmlBytes: positiveInteger('THUMBNAIL_JOB_MAX_HTML_BYTES', 16 * 1024 * 1024),
  maxDimension: positiveInteger('THUMBNAIL_JOB_MAX_DIMENSION', 4096),
  maxWaitingJobs: positiveInteger('THUMBNAIL_QUEUE_MAX_WAITING', 20),
  requestWaitMs: positiveInteger('THUMBNAIL_REQUEST_WAIT_MS', 5000),
  ogRequestWaitMs: positiveInteger('THUMBNAIL_OG_REQUEST_WAIT_MS', 15000),
  outputPollMs: positiveInteger('THUMBNAIL_OUTPUT_POLL_MS', 100),
  inputDirectory:
    process.env.THUMBNAIL_JOB_INPUT_PATH || path.join(cachePath, 'thumbnail-render-inputs'),
  outputDirectory:
    process.env.THUMBNAILS_CACHE_PATH || path.join(cachePath, 'thumbnails'),
});
