import { CronJob } from 'cron';
import { Op } from 'sequelize';
import AuditLog from '@/models/admin/AuditLog.js';
import { logger } from './LoggerService.js';

const RETENTION_PERIOD = 1000 * 60 * 60 * 24 * 30 * 2; // two month retention

/** Every 12 hours at minute 0 (e.g. 00:00 and 12:00 server local time). */
const RETENTION_CRON_SCHEDULE = '0 */12 * * *';

export class AuditLogService {
  private static retentionCron: CronJob | null = null;

  /**
   * Start the retention cleanup job (idempotent). Call once during app bootstrap.
   */
  static startScheduledRetention(): void {
    if (AuditLogService.retentionCron) {
      return;
    }
    AuditLogService.retentionCron = new CronJob(RETENTION_CRON_SCHEDULE, () => {
      void AuditLogService.deleteExpiredLogs();
    });
    AuditLogService.retentionCron.start();
    logger.info('[AuditLog] Retention cleanup scheduled (every 12 hours)');
  }

  /**
   * Delete audit rows older than the retention window.
   */
  static async deleteExpiredLogs(): Promise<number> {
    const cutoff = new Date(Date.now() - RETENTION_PERIOD);
    try {
      const deleted = await AuditLog.destroy({
        where: {
          createdAt: {
            [Op.lt]: cutoff,
          },
        },
      });
      if (deleted > 0) {
        logger.debug('[AuditLog] Retention cleanup removed old rows', {
          deleted,
          cutoff: cutoff.toISOString(),
        });
      }
      return deleted;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      logger.error('[AuditLog] Retention cleanup failed', { message, stack });
      return 0;
    }
  }

  /**
   * Log an admin action
   * @param {Object} params
   * @param {string|null} params.userId - The user performing the action
   * @param {string} params.action - The action performed (e.g., 'grant-role')
   * @param {string} params.route - The route path
   * @param {string} params.method - HTTP method
   * @param {any} params.payload - The request payload (will be stringified)
   * @param {any} params.result - The result/response (will be stringified)
   */
  static async log({
    userId,
    action,
    route,
    method,
    payload,
    result,
  }: {
    userId: string | null;
    action: string;
    route: string;
    method: string;
    payload?: any;
    result?: any;
  }) {
    try {
      await AuditLog.create({
        userId,
        action,
        route,
        method,
        payload: payload ? JSON.stringify(payload) : null,
        result: result ? JSON.stringify(result) : null,
      });
    } catch (err) {
      logger.error('Failed to write audit log:', err);
    }
  }
}
