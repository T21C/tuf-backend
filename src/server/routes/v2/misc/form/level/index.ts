import { Router } from 'express';

import validateRoute from './validateRoute.js';
import submitRoute from './submitRoute.js';
import selectLevelRoute from './selectLevelRoute.js';

const router: Router = Router();

router.use(validateRoute);
router.use(submitRoute);
router.use(selectLevelRoute);

export default router;
