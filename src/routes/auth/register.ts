import {Router} from 'express';
import {authController} from '../../controllers/auth.js';
import {createRateLimiter} from '../../utils/rateLimiter.js';

const router: Router = Router();

// Apply rate limiter to registration endpoint
const registrationLimiter = createRateLimiter({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  maxAttempts: 5,                // 10 accounts per 24 hours
  blockDuration: 1 * 60 * 1000, // 3 * 24 * 60 * 60 * 1000, // 3 days block
  type: 'registration'           // Specific type for registration
});

// Register new user
router.post('/', registrationLimiter, authController.register);

export default router;
