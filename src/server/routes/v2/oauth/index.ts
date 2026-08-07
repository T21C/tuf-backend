import { Router } from 'express';
import { oauthAsController } from '@/server/controllers/oauthAs.js';
import { Auth } from '@/server/middleware/auth.js';
import { requireCsrfForCookieAuth } from '@/server/middleware/csrf.js';

/**
 * Cookie-session consent APIs for the SPA at /oauth/consent.
 * Mounted at /v2/oauth so they share the Vite /v2 proxy and never collide with the SPA path.
 */
const router: Router = Router();

router.get('/consent', Auth.user(), (req, res) => oauthAsController.consentInfo(req, res));
router.post(
  '/consent/approve',
  Auth.user(),
  requireCsrfForCookieAuth,
  (req, res) => oauthAsController.consentApprove(req, res),
);
router.post(
  '/consent/deny',
  Auth.user(),
  requireCsrfForCookieAuth,
  (req, res) => oauthAsController.consentDeny(req, res),
);

export default router;
