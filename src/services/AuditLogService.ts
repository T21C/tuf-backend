import AuditLog from '../models/admin/AuditLog.js';

export class AuditLogService {
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
  static async log({ userId, action, route, method, payload, result }: {
    userId: string | null,
    action: string,
    route: string,
    method: string,
    payload?: any,
    result?: any,
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
      // Optionally log to console or fallback logger
      // eslint-disable-next-line no-console
      console.error('Failed to write audit log:', err);
    }
  }
} 