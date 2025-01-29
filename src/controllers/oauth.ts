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
async function handleDiscordOAuth(code: string): Promise<{
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
      redirect_uri: clientUrlEnv + '/callback',
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
      const scopes = ['identify', 'email'];
      const authUrl = `https://discord.com/api/oauth2/authorize?client_id=${
        process.env.DISCORD_CLIENT_ID
      }&redirect_uri=${encodeURIComponent(
        clientUrlEnv + '/callback',
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

      if (!code) {
        return res
          .status(400)
          .json({message: 'Authorization code is required'});
      }

      // Exchange code for tokens
      const tokens = await handleDiscordOAuth(code.toString());
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

      // First check if we have an existing OAuth provider
      const existingProvider = await OAuthProvider.findOne({
        where: {
          provider: 'discord',
          providerId: profile.id,
        },
        include: [
          {
            model: User,
            required: false,
          },
        ],
      });

      const existingUser = existingProvider?.get('User') as User | undefined;
      if (existingUser) {
        // Existing user, just update tokens and return
        await OAuthService.updateTokens(
          'discord',
          profile.id,
          tokens.tokens.access_token,
          tokens.tokens.refresh_token,
          new Date(Date.now() + tokens.tokens.expires_in * 1000),
        );

        const token = tokenUtils.generateJWT(existingUser);
        return res.json({
          user: {
            id: existingUser.id,
            username: existingUser.username,
            nickname: existingUser.nickname,
            email: existingUser.email,
            avatarUrl: existingUser.avatarUrl,
            isRater: existingUser.isRater,
            isSuperAdmin: existingUser.isSuperAdmin,
          },
          isNew: false,
          token,
        });
      }

      // First try to find player by Discord username
      let player = await Player.findOne({
        where: {
          name: profile.username,
        },
      });

      if (!player) {
        // Check player mapping as fallback
        console.log('No existing player found, checking player mapping');
        const playerMapping = findPlayerByDiscordId(profile.id);

        if (playerMapping) {
          console.log(`Found player mapping for ID ${profile.id}`);

          // Try to find existing player by mapping ID
          player = await Player.findOne({where: {name: playerMapping.name}});

          if (!player) {
            console.log('Creating new player with mapping data');
            player = await Player.create({
              name: playerMapping.name,
              country: playerMapping.region || 'XX',
              isBanned: false,
              createdAt: new Date(),
              updatedAt: new Date(),
            });
            console.log('Created new player:', player.id);
          }
        } else {
          // Create new player with next available ID
          console.log('No player mapping found, creating new player');
          const lastPlayer = await Player.findOne({
            order: [['id', 'DESC']],
          });
          const nextId = (lastPlayer?.id || 0) + 1;

          player = await Player.create({
            id: nextId,
            name: profile.username,
            country: 'XX',
            isBanned: false,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
          console.log('Created new player with ID:', player.id);
        }
      } else {
        console.log(`Found existing player with name ${player.name}`);
      }

      // Now create user directly since we need to include the player ID
      console.log('Creating new user with player ID:', player.id);
      const now = new Date();
      const isRater =
        provider === 'discord' &&
        (raterList.includes(profile.id) ||
          SUPER_ADMINS.includes(profile.username));
      const isSuperAdmin =
        provider === 'discord' && SUPER_ADMINS.includes(profile.username);

      const user = await User.create({
        id: uuidv4(),
        username: profile.username,
        email: profile.email || undefined,
        nickname: profile.global_name || undefined,
        avatarId: profile.avatar ? profile.avatar : undefined,
        avatarUrl: profile.avatar
          ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.${profile.avatar.startsWith('a_') ? 'gif' : 'png'}`
          : undefined,
        playerId: player.id,
        isEmailVerified: !!profile.email,
        isRater,
        isSuperAdmin,
        permissionVersion: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });

      // Create OAuth provider link
      await OAuthProvider.create({
        userId: user.id,
        provider: 'discord',
        providerId: profile.id,
        profile: profile,
        createdAt: now,
        updatedAt: now,
      });

      // Update OAuth tokens
      await OAuthService.updateTokens(
        'discord',
        profile.id,
        tokens.tokens.access_token,
        tokens.tokens.refresh_token,
        new Date(Date.now() + tokens.tokens.expires_in * 1000),
      );

      // Generate JWT
      const token = tokenUtils.generateJWT(user);

      res.json({
        user: {
          id: user.id,
          username: user.username,
          nickname: user.nickname,
          email: user.email,
          avatarUrl: user.avatarUrl,
          isRater: user.isRater,
          isSuperAdmin: user.isSuperAdmin,
        },
        isNew: true,
        token,
      });

      if (!req.leaderboardCache) {
        throw new Error('LeaderboardCache not initialized');
      }
      req.leaderboardCache
        .forceUpdate()
        .then(() => {
          return;
        })
        .catch(error => {
          console.error('Error updating leaderboard cache:', error);
          return;
        });
      playerStatsService
        .updatePlayerStats(player.id)
        .then(() => {
          return;
        })
        .catch(error => {
          console.error('Error updating player stats:', error);
          return;
        });

      return;
    } catch (error) {
      //console.error('OAuth callback error:', error);
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
        const {tokens, profile} = await handleDiscordOAuth(code);

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
      if (providers.length <= 1) {
        return res
          .status(400)
          .json({error: 'Cannot remove last authentication provider'});
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
