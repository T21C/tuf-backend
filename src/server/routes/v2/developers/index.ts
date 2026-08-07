import { Router } from 'express';
import { Auth } from '@/server/middleware/auth.js';
import { oauthDeveloperController } from '@/server/controllers/oauthDeveloper.js';
import { requireCsrfForCookieAuth } from '@/server/middleware/csrf.js';
import { multerMemoryCdnImage5Mb as upload } from '@/config/multerMemoryUploads.js';

const router: Router = Router();

router.get('/apps', Auth.user(), (req, res) => oauthDeveloperController.listMine(req, res));
router.post(
  '/apps',
  Auth.user(),
  requireCsrfForCookieAuth,
  (req, res) => oauthDeveloperController.create(req, res),
);
router.get('/apps/:id', Auth.user(), (req, res) => oauthDeveloperController.getOne(req, res));
router.patch(
  '/apps/:id',
  Auth.user(),
  requireCsrfForCookieAuth,
  (req, res) => oauthDeveloperController.update(req, res),
);
router.delete(
  '/apps/:id',
  Auth.user(),
  requireCsrfForCookieAuth,
  (req, res) => oauthDeveloperController.remove(req, res),
);
router.post(
  '/apps/:id/icon',
  Auth.user(),
  requireCsrfForCookieAuth,
  upload.single('icon'),
  (req, res) => oauthDeveloperController.uploadIcon(req, res),
);
router.delete(
  '/apps/:id/icon',
  Auth.user(),
  requireCsrfForCookieAuth,
  (req, res) => oauthDeveloperController.deleteIcon(req, res),
);

export default router;
