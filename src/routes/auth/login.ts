import {Router, Request, Response} from 'express';
import {User} from '../../models/index.js';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import {Op} from 'sequelize';
import {OAuthController} from '../../controllers/oauth.js';
import axios from 'axios';

const router: Router = Router();

// Track failed login attempts
const failedAttempts = new Map<string, {count: number; timestamp: number}>();
const ATTEMPT_TIMEOUT = 30 * 60 * 1000; // 30 minutes in milliseconds

// Helper to check if captcha is required
const isCaptchaRequired = (identifier: string): boolean => {
  const attempts = failedAttempts.get(identifier);
  if (!attempts) return false;

  // Clear attempts if timeout has passed
  if (Date.now() - attempts.timestamp > ATTEMPT_TIMEOUT) {
    failedAttempts.delete(identifier);
    return false;
  }

  return attempts.count >= 1;
};

// Helper to verify reCAPTCHA token
const verifyCaptcha = async (token: string): Promise<boolean> => {
  try {
    if (!process.env.RECAPTCHA_SECRET_KEY) {
      console.error('RECAPTCHA_SECRET_KEY is not set in environment variables');
      return false;
    }

    const verifyURL = 'https://www.google.com/recaptcha/api/siteverify';
    const params = new URLSearchParams({
      secret: process.env.RECAPTCHA_SECRET_KEY,
      response: token,
    });

    const response = await axios.post(verifyURL, params.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    if (!response.data.success) {
      console.error(
        'reCAPTCHA verification failed with error codes:',
        response.data['error-codes'],
      );
      return false;
    }

    return true;
  } catch (error: any) {
    console.error('reCAPTCHA verification failed:', error);
    if (error.response?.data) {
      console.error('Error response:', error.response.data);
    }
    return false;
  }
};

router.post('/', async (req: Request, res: Response) => {
  try {
    const {emailOrUsername, password, captchaToken} = req.body;

    if (!emailOrUsername || !password) {
      return res
        .status(400)
        .json({error: 'Email/Username and password are required'});
    }

    // Check if captcha is required
    if (isCaptchaRequired(emailOrUsername)) {
      if (!captchaToken) {
        return res
          .status(400)
          .json({error: 'Captcha required', requireCaptcha: true});
      }

      const isValidCaptcha = await verifyCaptcha(captchaToken);
      if (!isValidCaptcha) {
        return res
          .status(400)
          .json({error: 'Invalid captcha or high risk score detected'});
      }
    }

    // Find user by email or username
    const user = await User.findOne({
      where: {
        [Op.or]: [{email: emailOrUsername}, {username: emailOrUsername}],
      },
    });

    if (!user) {
      // Track failed attempt
      const attempts = failedAttempts.get(emailOrUsername) || {
        count: 0,
        timestamp: Date.now(),
      };
      attempts.count++;
      attempts.timestamp = Date.now();
      failedAttempts.set(emailOrUsername, attempts);

      return res.status(401).json({
        error: 'Invalid credentials',
        requireCaptcha: attempts.count >= 1,
      });
    }

    // If user has no password set (OAuth-only user)
    if (!user.password) {
      return res
        .status(401)
        .json({error: 'Please login with your linked provider'});
    }

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      // Track failed attempt
      const attempts = failedAttempts.get(emailOrUsername) || {
        count: 0,
        timestamp: Date.now(),
      };
      attempts.count++;
      attempts.timestamp = Date.now();
      failedAttempts.set(emailOrUsername, attempts);

      return res.status(401).json({
        error: 'Invalid credentials',
        requireCaptcha: attempts.count >= 1,
      });
    }

    // Clear failed attempts on successful login
    failedAttempts.delete(emailOrUsername);

    const token = jwt.sign(
      {id: user.id},
      process.env.JWT_SECRET || 'your-secret-key',
      {expiresIn: '24h'},
    );

    return res.json({token});
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({error: 'Failed to login'});
  }
});

// Login with OAuth provider
router.get('/:provider', OAuthController.initiateLogin);

export default router;
