import { Request, Response, Router } from 'express';
import Stripe from 'stripe';
import { ApiDoc } from '@/server/middleware/apiDoc.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { stripeConfig } from '@/config/app.config.js';
import { StripeWebhookService } from '@/server/services/billing/StripeWebhookService.js';

const router: Router = Router();

function logStripeOutcome(info: { type: string; httpStatus: number; billingEventId?: number | null; duplicate?: boolean }) {
  logger.info('[Stripe] webhook', info);
}

router.post(
  '/stripe',
  ApiDoc({
    operationId: 'postWebhookStripe',
    summary: 'Stripe webhook listener',
    description:
      'Verifies Stripe-Signature using the raw request body (`express.json` verify buffer), dedupes via billing_events, fulfills TUFStellar purchases.',
    tags: ['Webhooks'],
    security: [],
    responses: {
      204: { description: 'Accepted' },
      400: { description: 'Invalid signature or payload' },
      500: { description: 'Server error' },
    },
  }),
  async (req: Request & { rawBody?: Buffer }, res: Response) => {
    try {
      const secret = stripeConfig.webhookSecret;
      if (!secret) {
        logger.warn('[Stripe] STRIPE_WEBHOOK_SECRET is not set; rejecting webhook');
        return res.status(500).json({ error: { code: 'MISCONFIGURED', message: 'Webhook secret not configured' } });
      }
      if (!stripeConfig.secretKey) {
        logger.warn('[Stripe] STRIPE_SECRET_KEY is not set; rejecting webhook');
        return res.status(500).json({ error: { code: 'MISCONFIGURED', message: 'Stripe API key not configured' } });
      }

      const sigHeader = req.headers['stripe-signature'];
      const sig = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
      if (!sig) {
        logStripeOutcome({ type: 'missing_signature', httpStatus: 400 });
        return res.status(400).json({ error: { code: 'INVALID_SIGNATURE', message: 'Missing Stripe-Signature' } });
      }

      const rawBuf = req.rawBody;
      if (!rawBuf || !Buffer.isBuffer(rawBuf) || rawBuf.length === 0) {
        logStripeOutcome({ type: 'missing_raw_body', httpStatus: 400 });
        return res.status(400).json({ error: { code: 'INVALID_BODY', message: 'Missing raw body for signature verification' } });
      }

      const stripe = new Stripe(stripeConfig.secretKey, { typescript: true });
      let event: Stripe.Event;
      try {
        event = stripe.webhooks.constructEvent(rawBuf, sig, secret);
      } catch (e) {
        logStripeOutcome({ type: 'bad_signature', httpStatus: 400 });
        return res.status(400).json({ error: { code: 'INVALID_SIGNATURE', message: 'Invalid signature' } });
      }

      const record = await StripeWebhookService.recordIfNew(event);
      if (!record) {
        logStripeOutcome({ type: event.type, httpStatus: 204, duplicate: true });
        return res.status(204).send();
      }

      await StripeWebhookService.processEvent(record);

      logStripeOutcome({
        type: event.type,
        httpStatus: 204,
        billingEventId: record.id,
      });

      return res.status(204).send();
    } catch (e) {
      logger.error('[Stripe] Webhook handler error', e);
      return res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Server error' } });
    }
  },
);

export default router;
