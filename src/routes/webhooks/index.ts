import {Router} from 'express';
import webhook from './webhook.js';

const router: Router = Router();

router.use('/', webhook);

export default router;
