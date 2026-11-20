import 'dotenv/config';
import '@/observability/instrument.js';
import express from 'express';
import { logger } from '@/server/services/core/LoggerService.js';
import { registerGlobalProcessHandlers } from '@/server/bootstrap/processHandlers.js';
import { registerShutdownStep } from '@/server/bootstrap/shutdownCoordinator.js';
import { setTerminalServiceTitle } from '@/misc/utils/terminalTitle.js';
import { startBadgeJobWorker, stopBadgeJobWorker } from '@/server/services/badges/jobs/worker.js';

setTerminalServiceTitle('TUF Badge Worker');
registerGlobalProcessHandlers();

const port = Number(process.env.BADGE_WORKER_PORT || 3893);
const bindAddress = process.env.BADGE_WORKER_BIND_ADDRESS || '127.0.0.1';
const state = { ready: false, active: false };

const healthApp = express();
healthApp.get('/health', (_req, res) => {
  res.json({ ok: state.ready, service: 'badge-worker', active: state.active });
});

const server = healthApp.listen(port, bindAddress, () => {
  state.ready = true;
  logger.info(`[badges] worker listening on http://${bindAddress}:${port}/health`);
  startBadgeJobWorker();
  state.active = true;
});

registerShutdownStep({
  name: 'badge-worker',
  priority: 40,
  fn: async () => {
    state.active = false;
    stopBadgeJobWorker();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  },
});
