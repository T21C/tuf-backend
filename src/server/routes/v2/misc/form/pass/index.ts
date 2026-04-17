import { Router } from 'express';

import submitRoute from './submitRoute.js';

const router: Router = Router();

router.use(submitRoute);

export default router;
