import { CronJob } from 'cron';
import RefreshToken from '@/models/auth/RefreshToken.js';
import { logger } from './LoggerService.js';

const BATCH_SIZE = 2000;
/** Run every hour at minute 15 to avoid overlapping with peak auth traffic */
const CRON_SCHEDULE = '15 * * * *';

export class RefreshTokenCleanupService {
  private static instance: RefreshTokenCleanupService;
  private cronJob: CronJob | null = null;

  private constructor() {
    this.cronJob = new CronJob(CRON_SCHEDULE, () => {
      void this.runCleanup();
    });
    this.cronJob.start();
    logger.info('[RefreshTokenCleanup] Scheduled job started (hourly)');
  }

  public static getInstance(): RefreshTokenCleanupService {
    if (!RefreshTokenCleanupService.instance) {
      RefreshTokenCleanupService.instance = new RefreshTokenCleanupService();
    }
    return RefreshTokenCleanupService.instance;
  }

  /**
   * Delete revoked or expired refresh tokens in batches to avoid long locks.
   */
  public async runCleanup(): Promise<{ deleted: number; batches: number }> {
    const sequelize = RefreshToken.sequelize;
    if (!sequelize) {
      logger.warn('[RefreshTokenCleanup] No sequelize instance');
      return { deleted: 0, batches: 0 };
    }

    let totalDeleted = 0;
    let batches = 0;

    try {
      // MySQL: DELETE ... WHERE (revokedAt IS NOT NULL OR expiresAt < NOW()) LIMIT N
      // Run in batches to avoid holding locks for too long
      for (;;) {
        const [result] = await sequelize.query(
          `DELETE FROM refresh_tokens
           WHERE revokedAt IS NOT NULL OR expiresAt < NOW()
           LIMIT :limit`,
          {
            replacements: { limit: BATCH_SIZE },
            type: 'DELETE',
          }
        );
        const raw = result as { affectedRows?: number } | number;
        const affected = typeof raw === 'number' ? raw : (raw?.affectedRows ?? 0);
        totalDeleted += affected;
        batches += 1;
        if (affected < BATCH_SIZE) break;
      }

      if (totalDeleted > 0) {
        logger.info('[RefreshTokenCleanup] Cleaned up refresh_tokens', {
          deleted: totalDeleted,
          batches,
        });
      }
    } catch (err) {
      logger.error('[RefreshTokenCleanup] Cleanup failed', { error: err });
    }

    return { deleted: totalDeleted, batches };
  }
}
