import {Request, Response} from 'express';
import OAuthService from '../services/OAuthService.js';
import {tokenUtils} from '../utils/auth.js';
import {OAuthProvider} from '../models/index.js';
import axios from 'axios';
import {
  type RESTPostOAuth2AccessTokenResult,
  type RESTGetAPIUserResult,
} from 'discord-api-types/v10';
import dotenv from 'dotenv';
import { logger } from '../services/LoggerService.js';
import { clientUrlEnv, ownUrl } from '../config/app.config.js';
import { hasFlag } from '../utils/permissionUtils.js';
import { permissionFlags } from '../config/constants.js';


interface ProfileResponse {
  user: {
    id: string;
    username: string;
    nickname: string | null;
    email?: string;
    avatarUrl: string | null;
    isRater: boolean;
    isSuperAdmin: boolean;
    isEmailVerified: boolean;
    permissionFlags: string;
  };
  providers: {
    provider: string;
    providerId: string;
  }[];
}

dotenv.config();

// Helper function to handle Discord OAuth token exchange
async function handleDiscordOAuth(code: string, isLinking: boolean): Promise<{
  tokens: RESTPostOAuth2AccessTokenResult;
  profile: RESTGetAPIUserResult;
} | null> {
  // Exchange code for token
  try{
    const tokenResponse = await axios.post(
      'https://discord.com/api/oauth2/token',
      new URLSearchParams({
      client_id: process.env.DISCORD_CLIENT_ID!,
      client_secret: process.env.DISCORD_CLIENT_SECRET!,
      code: code.toString(),
      grant_type: 'authorization_code',
      redirect_uri: clientUrlEnv + '/callback'+ (isLinking ? '?linking=true' : ''),
    }),
    {
      headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    },
  );

  const tokens: RESTPostOAuth2AccessTokenResult = tokenResponse.data;

  // Get user profile
  const userResponse = await axios.get('https://discord.com/api/users/@me', {
    headers: {Authorization: `Bearer ${tokens.access_token}`},
  })

  return {
    tokens,
    profile: userResponse.data,
  };
} catch (error) {
  return null;
}
}

export const OAuthController = {
  /**
   * Initiate OAuth login process
   */
  async initiateLogin(req: Request, res: Response) {
    const {provider} = req.params;

    if (provider === 'discord') {
      if (!process.env.DISCORD_CLIENT_ID) {
        logger.error('DISCORD_CLIENT_ID is not set');
        return res.status(500).json({error: 'Discord client ID is not configured'});
      }

      const scopes = ['identify', 'email'];
      const redirectUri = clientUrlEnv + '/callback';

      const authUrl = `https://discord.com/api/oauth2/authorize?client_id=${
        process.env.DISCORD_CLIENT_ID
      }&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${scopes.join('%20')}`;

      return res.json({url: authUrl});
    }

    return res.status(400).json({error: 'Unsupported provider'});
  },

  /**
   * Initiate OAuth linking process
   */
  async initiateLink(req: Request, res: Response) {
    const {provider} = req.params;

    if (provider === 'discord') {
      const scopes = ['identify', 'email'];
      const authUrl = `https://discord.com/api/oauth2/authorize?client_id=${
        process.env.DISCORD_CLIENT_ID
      }&redirect_uri=${encodeURIComponent(
        clientUrlEnv + '/callback?linking=true',
      )}&response_type=code&scope=${scopes.join('%20')}`;
      return res.json({url: authUrl});
    }

    return res.status(400).json({error: 'Unsupported provider'});
  },

  /**
   * Handle OAuth callback
   */
  async handleCallback(req: Request, res: Response) {
    try {
      //const {provider} = req.params;
      const {code} = req.body;
      const isLinking = req.query.linking === 'true';

      if (!code) {
        return res
          .status(400)
          .json({message: 'Authorization code is required'});
      }

      const tokens = await handleDiscordOAuth(code.toString(), isLinking);
      if (!tokens) {
        return res
          .status(400)
          .json({message: 'Failed to exchange code for tokens'});
      }

      // Get user profile from provider
      const profile = tokens.profile;
      if (!profile) {
        return res.status(400).json({message: 'Failed to get user profile'});
      }
      if (isLinking) {
        // Handle linking flow
        if (!req.user) {
          return res.status(401).json({message: 'Authentication required for linking'});
        }

        try {
          await OAuthService.linkProvider(req.user.id, {
            id: profile.id,
            provider: 'discord',
            username: profile.username,
            email: profile.email || undefined,
          });

          // Update OAuth tokens
          await OAuthService.updateTokens(
            'discord',
            profile.id,
            tokens.tokens.access_token,
            tokens.tokens.refresh_token,
            new Date(Date.now() + tokens.tokens.expires_in * 1000),
          );

          return res.json({success: true});
        } catch (error: any) {
          if (error.message.includes('ERR_BAD_REQUEST') || (error.response && error.response.status === 400)) {
            return res.status(400).json({error: 'Invalid code'});
          }
          logger.error('Provider linking error:', error);
          return res.status(400).json({error: error.message || 'Failed to link provider'});
        }
      } else {
        // Handle login flow
        const [user, isNew] = await OAuthService.findOrCreateUser({
          id: profile.id,
          provider: 'discord',
          username: profile.username,
          email: profile.email || undefined,
        });

        // Update OAuth tokens
        await OAuthService.updateTokens(
          'discord',
          profile.id,
          tokens.tokens.access_token,
          tokens.tokens.refresh_token,
          new Date(Date.now() + tokens.tokens.expires_in * 1000),
        );

        const token = tokenUtils.generateJWT(user);
        return res.json({
          user: {
            id: user.id,
            username: user.username,
            nickname: user.nickname,
            email: user.email,
            avatarUrl: user.avatarUrl,
            isRater: hasFlag(user, permissionFlags.RATER),
            isSuperAdmin: hasFlag(user, permissionFlags.SUPER_ADMIN),
            isEmailVerified: hasFlag(user, permissionFlags.EMAIL_VERIFIED),
            permissionFlags: user.permissionFlags.toString(),
          },
          isNew,
          token,
        });
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('400')) {
        return res.status(400).json({message: 'Bad authentication code'});
      }
      //logger.error('OAuth callback error:', error);
      return res.status(500).json({message: 'Authentication failed'});
    }
  },

  /**
   * Get user profile
   */
  async getProfile(req: Request, res: Response) {
    try {
      const providers = await OAuthService.getUserProviders(req.user!.id);

      const avatarUrl = req.user!.avatarUrl
        ? `${ownUrl}/v2/media/avatar/${req.user!.id}`
        : null;

      const response: ProfileResponse = {
        user: {
          id: req.user!.id,
          username: req.user!.username,
          nickname: req.user!.nickname || null,
          email: req.user!.email,
          avatarUrl,
          isRater: hasFlag(req.user!, permissionFlags.RATER),
          isSuperAdmin: hasFlag(req.user!, permissionFlags.SUPER_ADMIN),
          isEmailVerified: hasFlag(req.user!, permissionFlags.EMAIL_VERIFIED),
          permissionFlags: req.user!.permissionFlags.toString(),
        },
        providers: providers.map((p: OAuthProvider) => ({
          provider: p.provider,
          providerId: p.providerId,
        })),
      };

      return res.json(response);
    } catch (error) {
      logger.error('Profile fetch error:', error);
      return res.status(500).json({error: 'Failed to fetch profile'});
    }
  },

  /**
   * Link provider to user account
   */
  async linkProvider(req: Request, res: Response) {
    const {provider} = req.params;
    const {code} = req.body;

    if (!code) {
      return res.status(400).json({error: 'Authorization code required'});
    }

    try {
      if (provider === 'discord') {
        const result = await handleDiscordOAuth(code, true);
        if (!result) {
          return res.status(400).json({error: 'Failed to exchange code for tokens'});
        }
        const {tokens, profile} = result;

        // Check if this provider is already linked to another user
        const existingProvider = await OAuthProvider.findOne({
          where: {
            provider: 'discord',
            providerId: profile.id,
          },
        });

        if (existingProvider) {
          return res.status(400).json({
            error: 'This Discord account is already linked to another user',
          });
        }

        // Link provider to user
        await OAuthService.linkProvider(req.user!.id, {
          id: profile.id,
          provider: 'discord',
          username: profile.username,
          email: profile.email || undefined,
        });

        // Update OAuth tokens
        await OAuthService.updateTokens(
          'discord',
          profile.id,
          tokens.access_token,
          tokens.refresh_token,
          new Date(Date.now() + tokens.expires_in * 1000),
        );

        return res.json({success: true});
      }

      return res.status(400).json({error: 'Unsupported provider'});
    } catch (error) {
      logger.error('Provider linking error:', error);
      return res.status(500).json({error: 'Failed to link provider'});
    }
  },

  /**
   * Unlink provider from user account
   */
  async unlinkProvider(req: Request, res: Response) {
    const {provider} = req.params;

    try {
      const providers = await OAuthService.getUserProviders(req.user!.id);

      if (providers.length <= 1 && !req.user?.password) {
        return res
          .status(400)
          .json({error: 'Cannot remove last authentication provider without a password'});
      }

      const success = await OAuthService.unlinkProvider(req.user!.id, provider);
      return res.json({success});
    } catch (error) {
      logger.error('Provider unlinking error:', error);
      return res.status(500).json({error: 'Failed to unlink provider'});
    }
  },

  /**
   * Refresh OAuth token
   */
  async refreshToken(req: Request, res: Response) {
    const {provider} = req.params;

    try {
      const providers = await OAuthService.getUserProviders(req.user!.id);
      const oauthProvider = providers.find(
        (p: OAuthProvider) => p.provider === provider,
      );

      if (!oauthProvider?.refreshToken) {
        return res.status(400).json({error: 'No refresh token available'});
      }

      if (provider === 'discord') {
        const tokenResponse = await axios.post(
          'https://discord.com/api/oauth2/token',
          new URLSearchParams({
            client_id: process.env.DISCORD_CLIENT_ID!,
            client_secret: process.env.DISCORD_CLIENT_SECRET!,
            refresh_token: oauthProvider.refreshToken,
            grant_type: 'refresh_token',
          }),
          {
            headers: {'Content-Type': 'application/x-www-form-urlencoded'},
          },
        );

        const tokens: RESTPostOAuth2AccessTokenResult = tokenResponse.data;

        // Update tokens in database
        await OAuthService.updateTokens(
          'discord',
          oauthProvider.providerId,
          tokens.access_token,
          tokens.refresh_token,
          new Date(Date.now() + tokens.expires_in * 1000),
        );

        return res.json({
          accessToken: tokens.access_token,
          expiresIn: tokens.expires_in,
        });
      }

      return res
        .status(400)
        .json({error: 'Provider not supported for token refresh'});
    } catch (error) {
      logger.error('Token refresh error:', error);
      return res.status(500).json({error: 'Failed to refresh token'});
    }
  },
};
