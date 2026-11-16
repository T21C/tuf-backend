import { Router } from 'express';

import submitRoute from './submitRoute.js';
import ownerRoute from './ownerRoute.js';

const router: Router = Router();

router.use(submitRoute);
router.use(ownerRoute);

export default router;
