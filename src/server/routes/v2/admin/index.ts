import {Router} from 'express';
import ratingRoutes from './rating.js';
import submissionRoutes from './submissions.js';
import backupRoutes from './backup.js';
import usersRoutes from './users.js';
import statisticsRoutes from './statistics.js';
import { Auth } from '@/server/middleware/auth.js';
import { requireAdminAuth } from '@/server/middleware/adminGate.js';
import auditLogRoutes from './auditLog.js';
import curationRoutes from './curations.js';
import discordRolesRoutes from './discordRoles.js';
import adminCreatorsRoutes from './creators.js';
import tournamentsRoutes from './tournaments.js';
import oauthClientsRoutes from './oauthClients.js';
import usefulLinksRoutes from './usefulLinks.js';
import modsRoutes from './mods.js';
// Import other admin routes here

const router: Router = Router();

// Default-deny: nothing below is reachable anonymously unless adminGate lists it.
// Per-route Auth.* guards still set the required privilege level.
router.use(requireAdminAuth);

router.use('/rating', ratingRoutes);
router.use('/submissions', submissionRoutes);
router.use('/backup', backupRoutes);
router.use('/users', usersRoutes);
router.use('/statistics', statisticsRoutes);
router.use('/audit-log', auditLogRoutes);
router.use('/curations', curationRoutes);
router.use('/discord', discordRolesRoutes);
router.use('/creators', adminCreatorsRoutes);
router.use('/tournaments', tournamentsRoutes);
router.use('/oauth-clients', oauthClientsRoutes);
router.use('/useful-links', usefulLinksRoutes);
router.use('/mods', modsRoutes);

router.head('/verify-password', Auth.superAdminPassword(), async (req, res) => {
      return res.status(200).send({});
});
// Add other admin routes here

export default router;
