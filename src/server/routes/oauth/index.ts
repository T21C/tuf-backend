import { Router } from 'express';
import { oauthAsController } from '@/server/controllers/oauthAs.js';
import { Auth } from '@/server/middleware/auth.js';
import { requireOAuthBearer } from '@/server/middleware/oauthScopeGate.js';

const router: Router = Router();

/**
 * Protocol endpoints only. Consent UI APIs live under /v2/oauth/* so the SPA
 * route GET /oauth/consent is never shadowed by JSON.
 */
router.get('/authorize', Auth.tryUser(), (req, res) => oauthAsController.authorize(req, res));

router.post('/token', (req, res) => oauthAsController.token(req, res));
router.post('/revoke', (req, res) => oauthAsController.revoke(req, res));

router.get(
  '/resource/user',
  requireOAuthBearer,
  (req, res) => oauthAsController.resourceUser(req, res),
);

export default router;
