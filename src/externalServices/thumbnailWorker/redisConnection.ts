import type {ConnectionOptions} from 'bullmq';
import {THUMBNAIL_WORKER_CONFIG} from './config.js';

export function createBullMqConnection(): ConnectionOptions {
  const redisUrl = new URL(THUMBNAIL_WORKER_CONFIG.redisUrl);
  if (redisUrl.protocol !== 'redis:' && redisUrl.protocol !== 'rediss:') {
    throw new Error('REDIS_URL must use redis:// or rediss://');
  }

  const databaseText = redisUrl.pathname.replace(/^\//, '');
  const database = databaseText ? Number(databaseText) : 0;
  if (!Number.isInteger(database) || database < 0) {
    throw new Error('REDIS_URL contains an invalid database number');
  }

  return {
    host: redisUrl.hostname,
    port: redisUrl.port ? Number(redisUrl.port) : 6379,
    username: redisUrl.username ? decodeURIComponent(redisUrl.username) : undefined,
    password: redisUrl.password ? decodeURIComponent(redisUrl.password) : undefined,
    db: database,
    // Required for BullMQ Worker blocking connections.
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    tls: redisUrl.protocol === 'rediss:' ? {servername: redisUrl.hostname} : undefined,
  };
}
