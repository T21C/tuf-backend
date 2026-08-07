import { Router } from 'express';
import { Auth } from '@/server/middleware/auth.js';
import { oauthAdminController } from '@/server/controllers/oauthDeveloper.js';
import { requireCsrfForCookieAuth } from '@/server/middleware/csrf.js';

const router: Router = Router();

router.get('/', Auth.superAdmin(), (req, res) => oauthAdminController.list(req, res));
router.delete(
  '/:id',
  Auth.superAdmin(),
  requireCsrfForCookieAuth,
  (req, res) => oauthAdminController.remove(req, res),
);
router.post(
  '/:id/freeze',
  Auth.superAdmin(),
  requireCsrfForCookieAuth,
  (req, res) => oauthAdminController.freeze(req, res),
);
router.post(
  '/:id/unfreeze',
  Auth.superAdmin(),
  requireCsrfForCookieAuth,
  (req, res) => oauthAdminController.unfreeze(req, res),
);
router.post(
  '/:id/verify',
  Auth.superAdmin(),
  requireCsrfForCookieAuth,
  (req, res) => oauthAdminController.verify(req, res),
);
router.post(
  '/:id/unverify',
  Auth.superAdmin(),
  requireCsrfForCookieAuth,
  (req, res) => oauthAdminController.unverify(req, res),
);

export default router;
