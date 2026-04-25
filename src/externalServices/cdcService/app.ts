import express from 'express';
import dotenv from 'dotenv';
import { registerGlobalProcessHandlers } from '@/server/bootstrap/processHandlers.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { startBinlogTailer } from './binlogTailer.js';

dotenv.config();

registerGlobalProcessHandlers();

const PORT = Number(process.env.CDC_HEALTH_PORT ?? 3990);

const app = express();

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'cdc' });
});

const server = app.listen(PORT, () => {
  logger.info(`[cdc] Health on http://0.0.0.0:${PORT}/health`);
});

const serverId = Number(process.env.CDC_SERVER_ID ?? '999901');
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

let stopTailer: (() => Promise<void>) | null = null;

startBinlogTailer({ serverId, redisUrl })
  .then((stop) => {
    stopTailer = stop;
  })
  .catch((err) => {
    logger.error('[cdc] Failed to start binlog tailer:', err);
    process.exit(1);
  });

async function shutdown(): Promise<void> {
  try {
    if (stopTailer) await stopTailer();
  } catch (e) {
    logger.warn('[cdc] stopTailer error:', e);
  }
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

process.on('SIGINT', () => {
  void shutdown().then(() => process.exit(0));
});
process.on('SIGTERM', () => {
  void shutdown().then(() => process.exit(0));
});

export default app;
