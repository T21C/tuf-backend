import { CronJob } from 'cron';
import { logger } from '@/server/services/core/LoggerService.js';
import { shouldStartBilibiliProxyCron } from '@/misc/utils/data/bilibiliProxy.js';
import {
  pullAndProbeNewBilibiliProxies,
  reprobeHealthyBilibiliProxies,
} from '@/server/services/media/bilibiliProxyRefresh.js';

const LIST_CRON = '0 * * * *';
const REPROBE_CRON = '*/15 * * * *';

export class BilibiliProxyCronService {
  private static listJob: CronJob | null = null;
  private static probeJob: CronJob | null = null;
  private static listRunning = false;
  private static probeRunning = false;

  static startScheduledRefresh(): void {
    if (!shouldStartBilibiliProxyCron(process.env)) {
      logger.info('Bilibili proxy cron not started (disabled or non-prod)');
      return;
    }
    if (BilibiliProxyCronService.listJob || BilibiliProxyCronService.probeJob) return;

    BilibiliProxyCronService.listJob = new CronJob(LIST_CRON, () => {
      void BilibiliProxyCronService.runListPull();
    });
    BilibiliProxyCronService.probeJob = new CronJob(REPROBE_CRON, () => {
      void BilibiliProxyCronService.runReprobe();
    });
    BilibiliProxyCronService.listJob.start();
    BilibiliProxyCronService.probeJob.start();
    logger.info('Bilibili proxy cron started (hourly list pull, 15m re-probe)');
    void BilibiliProxyCronService.runListPull();
  }

  private static async runListPull(): Promise<void> {
    if (BilibiliProxyCronService.listRunning) return;
    BilibiliProxyCronService.listRunning = true;
    try {
      await pullAndProbeNewBilibiliProxies();
    } catch (error) {
      logger.error('Bilibili proxy list pull failed', error);
    } finally {
      BilibiliProxyCronService.listRunning = false;
    }
  }

  private static async runReprobe(): Promise<void> {
    if (BilibiliProxyCronService.probeRunning) return;
    BilibiliProxyCronService.probeRunning = true;
    try {
      await reprobeHealthyBilibiliProxies();
    } catch (error) {
      logger.error('Bilibili proxy re-probe failed', error);
    } finally {
      BilibiliProxyCronService.probeRunning = false;
    }
  }
}
