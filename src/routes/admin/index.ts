import {Router} from 'express';
import ratingRoutes from './rating.js';
import submissionRoutes from './submissions.js';
import backupRoutes from './backup.js';
import usersRoutes from './users.js';
import statisticsRoutes from './statistics.js';
import { Auth } from '../../middleware/auth.js';
import auditLogRoutes from './auditLog.js';
import curationRoutes from './curations.js';
// Import other admin routes here

const router: Router = Router();


router.use('/rating', ratingRoutes);
router.use('/submissions', submissionRoutes);
router.use('/backup', backupRoutes);
router.use('/users', usersRoutes);
router.use('/statistics', statisticsRoutes);
router.use('/audit-log', auditLogRoutes);
router.use('/curations', curationRoutes);

router.head('/verify-password', Auth.superAdminPassword(), async (req, res) => {
      return res.status(200).send();
});
// Add other admin routes here

export default router;
