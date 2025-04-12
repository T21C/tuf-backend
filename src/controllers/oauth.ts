import {Request, Response} from 'express';
import OAuthService from '../services/OAuthService.js';
import {tokenUtils} from '../utils/auth.js';
import {OAuthProvider, User} from '../models/index.js';
import Player from '../models/Player.js';
import {findPlayerByDiscordId} from '../utils/playerMapping.js';
import axios from 'axios';
import {
  type RESTPostOAuth2AccessTokenResult,
  type RESTGetAPIUserResult,
} from 'discord-api-types/v10';
import dotenv from 'dotenv';
import {v4 as uuidv4} from 'uuid';
import {raterList, SUPER_ADMINS} from '../config/constants.js';
import {PlayerStatsService} from '../services/PlayerStatsService.js';

const playerStatsService = PlayerStatsService.getInstance();

interface ProfileResponse {
  user: {
    id: string;
    username: string;
    nickname: string | null;
    email?: string;
    avatarUrl: string | null;
    isRater: boolean;
    isSuperAdmin: boolean;
  };
  providers: {
    provider: string;
    providerId: string;
  }[];
}

dotenv.config();

const ownUrlEnv =
  process.env.NODE_ENV === 'production'
    ? process.env.PROD_API_URL
    : process.env.NODE_ENV === 'staging'
      ? process.env.STAGING_API_URL
      : process.env.NODE_ENV === 'development'
        ? process.env.DEV_URL
        : 'http://localhost:3002';

const clientUrlEnv =
  process.env.NODE_ENV === 'production'
    ? process.env.PROD_CLIENT_URL
    : process.env.NODE_ENV === 'staging'
      ? process.env.STAGING_CLIENT_URL
      : process.env.NODE_ENV === 'development'
        ? process.env.CLIENT_URL
        : 'http://localhost:5173';

// Helper function to handle Discord OAuth token exchange
async function handleDiscordOAuth(code: string, isLinking: boolean): Promise<{
  tokens: RESTPostOAuth2AccessTokenResult;
  profile: RESTGetAPIUserResult;
}> {
  // Exchange code for token
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
  });

  return {
    tokens,
    profile: userResponse.data,
  };
}

export const OAuthController = {
  /**
   * Initiate OAuth login process
   */
  async initiateLogin(req: Request, res: Response) {
    const {provider} = req.params;

    if (provider === 'discord') {
      if (!process.env.DISCORD_CLIENT_ID) {
        console.error('DISCORD_CLIENT_ID is not set');
        return res.status(500).json({error: 'Discord client ID is not configured'});
      }

      const scopes = ['identify', 'email'];
      const redirectUri = clientUrlEnv + '/callback';
      console.log('OAuth redirect URI:', redirectUri);
      
      const authUrl = `https://discord.com/api/oauth2/authorize?client_id=${
        process.env.DISCORD_CLIENT_ID
      }&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${scopes.join('%20')}`;
      
      console.log('Generated Discord auth URL:', authUrl);
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
      const {provider} = req.params;
      const {code} = req.body;
      const isLinking = req.query.linking === 'true';

      console.log('OAuth callback received:', { provider, code, isLinking });

      if (!code) {
        console.error('No authorization code provided');
        return res
          .status(400)
          .json({message: 'Authorization code is required'});
      }

      // Exchange code for tokens
      console.log('Exchanging code for tokens...');
      const tokens = await handleDiscordOAuth(code.toString(), isLinking);
      if (!tokens) {
        console.error('Failed to exchange code for tokens');
        return res
          .status(400)
          .json({message: 'Failed to exchange code for tokens'});
      }
      console.log('Successfully exchanged code for tokens');

      // Get user profile from provider
      const profile = tokens.profile;
      if (!profile) {
        console.error('Failed to get user profile from tokens');
        return res.status(400).json({message: 'Failed to get user profile'});
      }
      console.log('Retrieved user profile:', { 
        id: profile.id,
        username: profile.username,
        email: profile.email 
      });

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
          console.error('Provider linking error:', error);
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
            isRater: user.isRater,
            isSuperAdmin: user.isSuperAdmin,
          },
          isNew,
          token,
        });
      }
    } catch (error) {
      console.error('OAuth callback error:', error);
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
        ? `${ownUrlEnv}/v2/media/avatar/${req.user!.id}`
        : null;

      const response: ProfileResponse = {
        user: {
          id: req.user!.id,
          username: req.user!.username,
          nickname: req.user!.nickname || null,
          email: req.user!.email,
          avatarUrl,
          isRater: req.user!.isRater,
          isSuperAdmin: req.user!.isSuperAdmin,
        },
        providers: providers.map((p: OAuthProvider) => ({
          provider: p.provider,
          providerId: p.providerId,
        })),
      };

      return res.json(response);
    } catch (error) {
      console.error('Profile fetch error:', error);
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
        const {tokens, profile} = await handleDiscordOAuth(code, true);

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
      console.error('Provider linking error:', error);
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
      console.error('Provider unlinking error:', error);
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
      console.error('Token refresh error:', error);
      return res.status(500).json({error: 'Failed to refresh token'});
    }
  },
};
