import { Router } from 'express';
import v2Router from './v2/index.js';
import v3Router from './v3/index.js';
import oauthRouter from './oauth/index.js';
import { oauthAsController } from '@/server/controllers/oauthAs.js';

const router: Router = Router();

router.get('/.well-known/oauth-authorization-server', (req, res) =>
  oauthAsController.wellKnown(req, res),
);
router.use('/oauth', oauthRouter);
router.use('/v2', v2Router);
router.use('/v3', v3Router);

export default router;
