import express, { Request, Response, Router } from 'express';
import { ApiDoc } from '@/server/middleware/apiDoc.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { XsollaWebhookService } from '@/server/services/billing/XsollaWebhookService.js';
import { User } from '@/models/index.js';

const router: Router = express.Router();

const XSOLLA_WEBHOOK_SECRET = process.env.XSOLLA_WEBHOOK_SECRET || '';

/** Single-line visibility while building the Xsolla pipeline. */
function logXsollaOutcome(info: {
  type: string;
  httpStatus: number;
  billingEventId?: number | null;
  duplicate?: boolean;
}) {
  logger.info('[Xsolla] webhook', info);
}

/**
 * Xsolla requires signature verification against the *raw* JSON payload.
 * Use `express.raw` for this route only; parse JSON manually after verification.
 */
router.post(
  '/xsolla',
  express.raw({ type: 'application/json' }),
  ApiDoc({
    operationId: 'postWebhookXsolla',
    summary: 'Xsolla webhook listener',
    description:
      'Receives Xsolla webhooks, verifies signature against raw body, dedupes via billing_events, and enqueues minimal processing.',
    tags: ['Webhooks'],
    // public endpoint; Xsolla signs requests
    security: [],
    responses: {
      204: { description: 'Accepted (no content)' },
      400: { description: 'Rejected (invalid signature / payload)' },
      500: { description: 'Server error' },
    },
  }),
  async (req: Request & { rawBody?: Buffer }, res: Response) => {
    try {
      if (!XSOLLA_WEBHOOK_SECRET) {
        logger.warn('[Xsolla] XSOLLA_WEBHOOK_SECRET is not set; rejecting webhook');
        return res.status(500).json({ error: { code: 'MISCONFIGURED', message: 'Webhook secret not configured' } });
      }

      const body = req.body;
      const rawBody = req.rawBody;

      const authHeader = req.headers['authorization'];
      const auth = Array.isArray(authHeader) ? authHeader[0] : authHeader;

      if (!XsollaWebhookService.verifySignature(rawBody!, XSOLLA_WEBHOOK_SECRET, auth)) {
        const t = typeof body?.notification_type === 'string' ? body.notification_type : 'signature';
        logXsollaOutcome({ type: t, httpStatus: 400 });
        return res.status(400).json({ error: { code: 'INVALID_SIGNATURE', message: 'Invalid signature' } });
      }

      const notificationType = String(body?.notification_type || '');
      if (!notificationType) {
        logXsollaOutcome({ type: 'unknown', httpStatus: 400 });
        return res.status(400).json({ error: { code: 'INVALID_PARAMETER', message: 'Missing notification_type' } });
      }

      // Xsolla "universal" tests expect specific status codes for validation/search webhooks.
      // Use our auth users table as the source of truth: `user.id` / `user.public_id` is a UUID in our system.
      if (notificationType === 'user_validation') {
        const rawId = body?.user?.id ?? body?.user?.external_id ?? body?.user?.externalId;
        const targetUserId =
          rawId != null && typeof rawId === 'object' && rawId !== null && 'value' in rawId
            ? String((rawId as { value: unknown }).value ?? '').trim()
            : rawId != null && rawId !== ''
              ? String(rawId).trim()
              : '';
        const user = targetUserId ? await User.findByPk(targetUserId) : null;
        if (!user) {
          logXsollaOutcome({ type: notificationType, httpStatus: 400 });
          return res.status(400).json({ error: { code: 'INVALID_USER', message: 'Invalid user' } });
        }
        logXsollaOutcome({ type: notificationType, httpStatus: 200 });
        return res.status(200).json({});
      }

      if (notificationType === 'user_search') {
        const publicId = body?.user?.public_id != null ? String(body.user.public_id) : '';
        const user = publicId ? await User.findByPk(publicId) : null;
        if (!user) {
          logXsollaOutcome({ type: notificationType, httpStatus: 404 });
          return res.status(404).json({ error: { code: 'INVALID_USER', message: 'Invalid user' } });
        }
        logXsollaOutcome({ type: notificationType, httpStatus: 200 });
        return res.status(200).json({
          user: {
            id: user.id,
          },
        });
      }

      const record = await XsollaWebhookService.recordIfNew({
        notificationType,
        body,
      });

      if (!record) {
        logXsollaOutcome({ type: notificationType, httpStatus: 204, duplicate: true });
        return res.status(204).send();
      }

      await XsollaWebhookService.processEvent(record);

      logXsollaOutcome({
        type: notificationType,
        httpStatus: 204,
        billingEventId: record.id,
      });

      return res.status(204).send();
    } catch (e) {
      logger.error('[Xsolla] Webhook handler error', e);
      return res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Server error' } });
    }
  },
);

export default router;
