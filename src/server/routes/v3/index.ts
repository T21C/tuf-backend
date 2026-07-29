import { Router } from 'express';
import playersRouter from './players.js';
import creatorsRouter from './creators.js';
import levelsModificationRouter from './levels/modification.js';
import levelsTeamRouter from './levels/team.js';
import billingRoutes from './billing/index.js';
import profileCustomizationRouter from './profileCustomization.js';
import teamsRouter from './teams.js';

const router: Router = Router();

router.use('/players', playersRouter);
router.use('/creators', creatorsRouter);
router.use('/profile-customization', profileCustomizationRouter);
router.use('/levels', levelsModificationRouter);
router.use('/levels', levelsTeamRouter);
router.use('/teams', teamsRouter);
router.use('/billing', billingRoutes);


export default router;
