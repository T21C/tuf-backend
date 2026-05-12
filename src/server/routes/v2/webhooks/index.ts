import {Router} from 'express';
import webhook from './webhook.js';
import stripe from './stripe.js';

const router: Router = Router();

router.use('/', webhook);
router.use('/', stripe);

export default router;
