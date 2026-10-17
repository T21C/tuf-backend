import {CronJob} from 'cron';
import {logger} from '@/server/services/core/LoggerService.js';
import {runArtistVerificationSync} from './artistVerificationSync.js';

/** Every 15 minutes. */
const CRON_SCHEDULE = '*/15 * * * *';

export class ArtistVerificationSyncCronService {
  private static cron: CronJob | null = null;

  static startScheduledSync(): void {
    if (process.env.ARTIST_VERIFICATION_SYNC_DISABLED === '1') {
      logger.info('Artist verification sync cron disabled (ARTIST_VERIFICATION_SYNC_DISABLED=1)');
      return;
    }
    if (ArtistVerificationSyncCronService.cron) return;

    ArtistVerificationSyncCronService.cron = new CronJob(CRON_SCHEDULE, async () => {
      try {
        const result = await runArtistVerificationSync();
        logger.info('Artist verification scheduled sync finished', result);
      } catch (error) {
        logger.error('Artist verification scheduled sync failed', error);
      }
    });

    ArtistVerificationSyncCronService.cron.start();
    logger.info('Artist verification sync cron started');
  }
}
