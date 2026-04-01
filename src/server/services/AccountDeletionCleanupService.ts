import { CronJob } from 'cron';
import { Op } from 'sequelize';
import User from '@/models/auth/User.js';
import { logger } from '@/server/services/LoggerService.js';
import { AccountDeletionService } from '@/server/services/AccountDeletionService.js';

const CRON_SCHEDULE = '*/10 * * * *'; // every 10 minutes
const BATCH_SIZE = 200;

export class AccountDeletionCleanupService {
  private static instance: AccountDeletionCleanupService;
  private cronJob: CronJob | null = null;
  private accountDeletionService = AccountDeletionService.getInstance();

  private constructor() {
    this.cronJob = new CronJob(CRON_SCHEDULE, () => {
      void this.runDueDeletions();
    });
    this.cronJob.start();
    logger.info('[AccountDeletionCleanup] Scheduled job started (every 10 minutes)');
  }

  public static getInstance(): AccountDeletionCleanupService {
    if (!AccountDeletionCleanupService.instance) {
      AccountDeletionCleanupService.instance = new AccountDeletionCleanupService();
    }
    return AccountDeletionCleanupService.instance;
  }

  public async runDueDeletions(): Promise<{ processed: number; deleted: number }> {
    try {
      const dueUsers = await User.findAll({
        where: {
          deletionExecuteAt: { [Op.not]: null, [Op.lte]: new Date() },
          deletionScheduledAt: { [Op.not]: null },
        },
        attributes: ['id'],
        limit: BATCH_SIZE,
      });

      let deleted = 0;
      for (const u of dueUsers) {
        try {
          const didDelete = await this.accountDeletionService.executeHardDeleteIfDue(u.id);
          logger.debug('[AccountDeletionCleanup] Deleted scheduled user', {
            userId: u.id,
            didDelete,
          });
          if (didDelete) deleted += 1;
        } catch (err) {
          logger.error('[AccountDeletionCleanup] Failed to delete scheduled user', {
            userId: u.id,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (dueUsers.length > 0) {
        logger.debug('[AccountDeletionCleanup] Batch processed', {
          processed: dueUsers.length,
          deleted,
        });
      }

      return { processed: dueUsers.length, deleted };
    } catch (err) {
      logger.error('[AccountDeletionCleanup] Batch lookup failed', {
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      return { processed: 0, deleted: 0 };
    }
  }
}

