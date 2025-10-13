import express from 'express';
import docsRouter from './docs.js';
import apiRouter from './api.js';

const router = express.Router();

router.use('/', docsRouter);
router.use('/api', apiRouter);

export default router;
