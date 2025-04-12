import {Router} from 'express';
import {OAuthController} from '../../controllers/oauth.js';
import {Auth} from '../../middleware/auth.js';

const router: Router = Router();

// OAuth callback
router.post(
  '/callback/:provider',
  OAuthController.handleCallback,
);

// Get OAuth profile
router.get('/me', Auth.user(), OAuthController.getProfile);

// Initiate OAuth login
router.get('/login/:provider', OAuthController.initiateLogin);

// Initiate OAuth linking
router.get('/link/:provider', Auth.user(), OAuthController.initiateLink);

// Link OAuth provider
router.post('/link/:provider', Auth.user(), OAuthController.linkProvider);

// Unlink OAuth provider
router.post('/unlink/:provider', Auth.user(), OAuthController.unlinkProvider);

// Refresh OAuth token
router.post('/refresh/:provider', Auth.user(), OAuthController.refreshToken);

export default router;
