import { CronJob } from 'cron';
import { logger } from '@/server/services/core/LoggerService.js';
import {
  WeeklyScheduleFillService,
  getWeekStartMonday,
} from '@/server/services/curations/WeeklyScheduleFillService.js';

/** Sunday 06:00 UTC — auto-fill the upcoming week when it has no schedule yet. */
const CRON_SCHEDULE = '0 6 * * 0';

export class WeeklyScheduleFillCronService {
  private static cron: CronJob | null = null;

  static startScheduledFill(): void {
    if (process.env.WEEKLY_CURATION_SCHEDULE_CRON_DISABLED === '1') {
      logger.info('Weekly curation schedule cron disabled (WEEKLY_CURATION_SCHEDULE_CRON_DISABLED=1)');
      return;
    }
    if (WeeklyScheduleFillCronService.cron) return;

    WeeklyScheduleFillCronService.cron = new CronJob(CRON_SCHEDULE, async () => {
      try {
        await WeeklyScheduleFillCronService.runNextWeekFill();
      } catch (error) {
        logger.error('Weekly curation schedule cron failed', error);
      }
    });

    WeeklyScheduleFillCronService.cron.start();
    logger.info('Weekly curation schedule cron started');
  }

  /** Fill the week starting on the next Monday (no-op if any row already exists). */
  static async runNextWeekFill(): Promise<void> {
    const now = new Date();
    const nextMonday = getWeekStartMonday(now);
    nextMonday.setUTCDate(nextMonday.getUTCDate() + 7);

    const result = await WeeklyScheduleFillService.fillWeek({
      weekStart: nextMonday,
      halls: 'both',
      scheduledBy: 'system',
      mode: 'cron',
    });

    if (result.skipped) {
      logger.info('[curation-schedule] Cron skipped (week already populated)', {
        weekStart: nextMonday.toISOString().split('T')[0],
      });
    }
  }
}

export default WeeklyScheduleFillCronService;
