import {CronJob} from 'cron';
import {logger} from '@/server/services/core/LoggerService.js';
import {runBotModsSync} from './botModSync.js';

/** Every 15 minutes. */
const CRON_SCHEDULE = '*/15 * * * *';

export class BotModsSyncCronService {
  private static cron: CronJob | null = null;

  static startScheduledSync(): void {
    if (process.env.BOT_MODS_SYNC_DISABLED === '1') {
      logger.info('Bot mods sync cron disabled (BOT_MODS_SYNC_DISABLED=1)');
      return;
    }
    if (BotModsSyncCronService.cron) return;

    BotModsSyncCronService.cron = new CronJob(CRON_SCHEDULE, async () => {
      try {
        const result = await runBotModsSync();
        logger.info('Bot mods scheduled sync finished', result);
      } catch (error) {
        logger.error('Bot mods scheduled sync failed', error);
      }
    });

    BotModsSyncCronService.cron.start();
    logger.info('Bot mods sync cron started');
  }
}
