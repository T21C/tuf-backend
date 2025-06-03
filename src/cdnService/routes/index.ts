import express from 'express';
import imagesRouter from './images.js';
import zipsRouter from './zips.js';
import moderationRouter from './moderation.js';
import generalRouter from './general.js';

const router = express.Router();

router.use('/images', imagesRouter);
router.use('/zips', zipsRouter);
router.use('/moderation', moderationRouter);
router.use('/', generalRouter);

export default router;
