import {Router} from 'express';

const router: Router = Router();

// Register new user
router.post('/', (req, res) => {
  return res.json({message: 'Registration temporarily disabled.'});
});

export default router;
