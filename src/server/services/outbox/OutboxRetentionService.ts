import { CronJob } from 'cron';
import { Op } from 'sequelize';
import OutboxEvent from '@/models/outbox/OutboxEvent.js';
import { logger } from '@/server/services/core/LoggerService.js';

const RETENTION_MS = 1000 * 60 * 60 * 24 * 7;
const CRON_SCHEDULE = '15 */12 * * *';

export class OutboxRetentionService {
  private static cron: CronJob | null = null;

  static startScheduledRetention(): void {
    if (OutboxRetentionService.cron) return;
    OutboxRetentionService.cron = new CronJob(CRON_SCHEDULE, () => {
      void OutboxRetentionService.deletePublishedOlderThanRetention();
    });
    OutboxRetentionService.cron.start();
    logger.info('[outbox] Retention cleanup scheduled (every 12 hours at :15)');
  }

  static async deletePublishedOlderThanRetention(): Promise<number> {
    const cutoff = new Date(Date.now() - RETENTION_MS);
    try {
      const deleted = await OutboxEvent.destroy({
        where: {
          [Op.and]: [{ publishedAt: { [Op.ne]: null } }, { publishedAt: { [Op.lt]: cutoff } }],
        },
      });
      if (deleted > 0) {
        logger.debug('[outbox] Retention cleanup removed published rows', { deleted, cutoff: cutoff.toISOString() });
      }
      return deleted;
    } catch (err) {
      logger.error('[outbox] Retention cleanup failed', err);
      return 0;
    }
  }
}
