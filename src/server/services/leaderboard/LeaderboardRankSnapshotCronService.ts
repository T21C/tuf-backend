import { CronJob } from 'cron';
import { logger } from '@/server/services/core/LoggerService.js';
import { LeaderboardRankSnapshotService } from '@/server/services/leaderboard/LeaderboardRankSnapshotService.js';

/** Daily ~06:15 UTC — persist yesterday's leaderboard rank deltas (closed UTC day). */
const CRON_SCHEDULE = '15 6 * * *';

export class LeaderboardRankSnapshotCronService {
  private static cron: CronJob | null = null;

  static startScheduledSnapshots(): void {
    if (process.env.LEADERBOARD_RANK_SNAPSHOT_CRON_DISABLED === '1') {
      logger.info('Leaderboard rank snapshot cron disabled (LEADERBOARD_RANK_SNAPSHOT_CRON_DISABLED=1)');
      return;
    }
    if (LeaderboardRankSnapshotCronService.cron) return;

    LeaderboardRankSnapshotCronService.cron = new CronJob(CRON_SCHEDULE, async () => {
      try {
        await LeaderboardRankSnapshotService.runYesterdaySnapshot();
      } catch (error) {
        logger.error('Leaderboard rank snapshot cron failed', error);
      }
    });

    LeaderboardRankSnapshotCronService.cron.start();
    logger.info('Leaderboard rank snapshot cron started');
  }
}
