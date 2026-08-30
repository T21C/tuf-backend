import express from 'express';
import imagesRouter from './images.js';
import zipsRouter from './zips.js';
import generalRouter from './general.js';
import levelsRouter from './levels.js';
import modZipsRouter from '../http/routes/modZips.js';
import { requireCdnIngestKey } from '@/externalServices/cdnService/http/middleware/requireCdnIngestKey.js';

const router = express.Router();

router.use(requireCdnIngestKey);

router.use('/images', imagesRouter);
router.use('/zips', zipsRouter);
router.use('/mod-zips', modZipsRouter);
router.use('/levels', levelsRouter);
router.use('/', generalRouter);

export default router;
