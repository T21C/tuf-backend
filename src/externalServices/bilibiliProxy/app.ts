import '@/observability/instrument.js';
import express from 'express';
import { createServer } from 'node:http';
import { logger } from '@/server/services/core/LoggerService.js';
import { redis } from '@/server/services/core/RedisService.js';
import { registerGlobalProcessHandlers } from '@/server/bootstrap/processHandlers.js';
import { registerShutdownStep } from '@/server/bootstrap/shutdownCoordinator.js';
import { setTerminalServiceTitle } from '@/misc/utils/terminalTitle.js';
import { BILIBILI_PROXY_CONFIG } from './config.js';
import { getHealthyCount } from './pool.js';
import { BilibiliProxyCronService } from './cron.js';
import {
  BVID_PATTERN,
  downloadBilibiliCoverByBvid,
  getBilibiliVideoDetailsByBvid,
} from './videoDetails.js';

setTerminalServiceTitle('TUF Bilibili Proxy');
registerGlobalProcessHandlers();

const state = {
  ready: false,
  redisReady: false,
};

try {
  logger.info('[bilibili-proxy] connecting to Redis');
  await redis.connect();
  state.redisReady = redis.isConnected();
} catch (error) {
  logger.error('[bilibili-proxy] Redis connect failed', error);
  state.redisReady = false;
}

registerShutdownStep({
  name: 'bilibili-proxy-redis',
  priority: 90,
  fn: () => redis.disconnect(),
});

const app = express();

app.get('/health', async (_req, res) => {
  const redisReady = state.redisReady && redis.isConnected();
  const ok = state.ready && redisReady;
  const healthyCount = redisReady ? await getHealthyCount() : 0;
  res.status(ok ? 200 : 503).json({
    ok,
    service: 'bilibili-proxy',
    redisReady,
    healthyCount,
  });
});

app.get('/video-details', async (req, res) => {
  const bvid = typeof req.query.bvid === 'string' ? req.query.bvid : '';
  if (!BVID_PATTERN.test(bvid)) {
    return res.status(400).json({ error: 'Invalid bvid' });
  }
  const details = await getBilibiliVideoDetailsByBvid(bvid);
  if (!details) {
    return res.status(404).json({ error: 'Video details not found' });
  }
  return res.json(details);
});

app.get('/cover', async (req, res) => {
  const bvid = typeof req.query.bvid === 'string' ? req.query.bvid : '';
  if (!BVID_PATTERN.test(bvid)) {
    return res.status(400).send('Invalid bvid');
  }
  const cover = await downloadBilibiliCoverByBvid(bvid);
  if (!cover) {
    return res.status(404).send('Cover not found');
  }
  res.set('Content-Type', cover.contentType);
  res.set('Cache-Control', 'public, max-age=86400');
  return res.send(cover.buffer);
});

const server = createServer(app);
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(BILIBILI_PROXY_CONFIG.port, BILIBILI_PROXY_CONFIG.bindAddress, () => resolve());
});

state.ready = true;
logger.info('[bilibili-proxy] ready', {
  health: `http://${BILIBILI_PROXY_CONFIG.bindAddress}:${BILIBILI_PROXY_CONFIG.port}/health`,
  redisReady: state.redisReady,
});

if (state.redisReady) {
  BilibiliProxyCronService.startScheduledRefresh();
} else {
  logger.warn('[bilibili-proxy] cron not started (Redis unavailable)');
}

registerShutdownStep({
  name: 'bilibili-proxy-http',
  priority: 60,
  fn: () =>
    new Promise<void>((resolve, reject) => {
      state.ready = false;
      server.close((error) => (error ? reject(error) : resolve()));
    }),
});
