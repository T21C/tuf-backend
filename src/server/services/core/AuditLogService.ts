import { CronJob } from 'cron';
import { Op } from 'sequelize';
import AuditLog from '@/models/admin/AuditLog.js';
import { logger } from './LoggerService.js';

const RETENTION_PERIOD = 1000 * 60 * 60 * 24 * 30 * 2; // two month retention

/** Every 12 hours at minute 0 (e.g. 00:00 and 12:00 server local time). */
const RETENTION_CRON_SCHEDULE = '0 */12 * * *';

const REDACTED = '[REDACTED]';

/** Exact key names (case-insensitive) stripped from audit payload/result JSON. */
const SENSITIVE_AUDIT_KEYS = new Set([
  'password',
  'superadminpassword',
  'currentpassword',
  'newpassword',
  'oldpassword',
  'passwordhash',
  'passwordresettoken',
  'passwordresettokenhash',
  'emailverifytoken',
  'emailverifytokenhash',
  'token',
  'refreshtoken',
  'accesstoken',
  'csrftoken',
  'captchatoken',
  'secret',
  'clientsecret',
  'authorization',
  'x-super-admin-password',
]);

/**
 * Deep-clone JSON-like values while replacing sensitive keys with a placeholder.
 * Non-plain objects (Date, Buffer, etc.) are stringified to a safe label.
 */
export function redactForAudit(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value == null) return value;
  if (typeof value !== 'object') return value;

  if (seen.has(value as object)) return '[Circular]';
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) => redactForAudit(item, seen));
  }

  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return '[Buffer]';

  // Only walk plain objects / records — avoid dumping class internals.
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    return '[Object]';
  }

  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_AUDIT_KEYS.has(key.toLowerCase())) {
      out[key] = REDACTED;
    } else {
      out[key] = redactForAudit(nested, seen);
    }
  }
  return out;
}

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
      const safePayload = payload != null ? redactForAudit(payload) : null;
      const safeResult = result != null ? redactForAudit(result) : null;
      await AuditLog.create({
        userId,
        action,
        route,
        method,
        payload: safePayload != null ? JSON.stringify(safePayload) : null,
        result: safeResult != null ? JSON.stringify(safeResult) : null,
      });
    } catch (err) {
      logger.error('Failed to write audit log:', err);
    }
  }
}
