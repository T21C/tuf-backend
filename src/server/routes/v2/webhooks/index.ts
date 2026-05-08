import {Router} from 'express';
import webhook from './webhook.js';
import xsolla from './xsolla.js';

const router: Router = Router();

router.use('/', webhook);
router.use('/', xsolla);

export default router;
