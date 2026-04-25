import {Router, Request, Response} from 'express';
import {Auth} from '@/server/middleware/auth.js';
import { ApiDoc } from '@/server/middleware/apiDoc.js';
import { errorResponseSchema, successMessageSchema, standardErrorResponses, standardErrorResponses404500, standardErrorResponses500, stringIdParamSpec } from '@/server/schemas/v2/profile/index.js';
import {OAuthProvider, User} from '@/models/index.js';
import bcrypt from 'bcryptjs';
import sequelize from '@/config/db.js';
import { Op } from 'sequelize';
import UsernameChange from '@/models/auth/UsernameChange.js';
import Player from '@/models/players/Player.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { multerMemoryCdnImage10Mb as upload } from '@/config/multerMemoryUploads.js';
import cdnService from '@/server/services/core/CdnService.js';
import { CdnError } from '@/server/services/core/CdnService.js';
import { safeTransactionRollback } from '@/misc/utils/Utility.js';
import ElasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';
import { hasFlag, type PermissionInput } from '@/misc/utils/auth/permissionUtils.js';
import { parseBannerPresetForStorage } from '@/misc/utils/profileBannerPreset.js';
import { permissionFlags } from '@/config/constants.js';
import { Cache, CacheInvalidation } from '@/server/middleware/cache.js';
import { AccountDeletionService } from '@/server/services/accounts/AccountDeletionService.js';

const router: Router = Router();
const elasticsearchService = ElasticsearchService.getInstance();
const accountDeletionService = AccountDeletionService.getInstance();

const usernameChangeCooldown = 1 * 24 * 60 * 60 * 1000; // 1 day

// Get current user profile
router.get(
  '/me',
  Auth.user(),
  ApiDoc({
    operationId: 'getProfileMe',
    summary: 'Get current user profile',
    description: 'Returns the authenticated user profile with player and OAuth providers',
    tags: ['Profile'],
    security: ['bearerAuth'],
    responses: {
      200: {
        description: 'User profile',
        schema: {
          type: 'object',
          properties: {
            user: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                username: { type: 'string' },
                email: { type: 'string' },
                avatarUrl: { type: 'string' },
                isRater: { type: 'boolean' },
                isSuperAdmin: { type: 'boolean' },
                playerId: { type: 'string' },
                player: { type: 'object' },
              },
            },
          },
        },
      },
      401: { description: 'Unauthorized', schema: errorResponseSchema },
      500: { description: 'Server error', schema: errorResponseSchema },
    },
  }),
  Cache({
    varyByUser: true,
    tags: (req: Request) => [`user:${req.user?.id}`]
  }),
  async (req: Request, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({error: 'User not authenticated'});
    }

    // Fetch providers with profile data
    const providers = await OAuthProvider.findAll({
      where: {userId: user.id},
      attributes: ['provider', 'profile'],
    });

    const player = await Player.findByPk(user.playerId);

    return res.json({
      user: {
        id: user.id,
        creatorId: user.creatorId,
        username: user.username,
        nickname: user.nickname || user.username,
        email: user.email,
        avatarUrl: user.avatarUrl,
        isRater: hasFlag(user, permissionFlags.RATER),
        isSuperAdmin: hasFlag(user, permissionFlags.SUPER_ADMIN),
        isRatingBanned: hasFlag(user, permissionFlags.RATING_BANNED),
        isEmailVerified: hasFlag(user, permissionFlags.EMAIL_VERIFIED),
        permissionFlags: user.permissionFlags,
        playerId: user.playerId,
        password: user.password ? true : null,
        player,
        lastUsernameChange: user.lastUsernameChange,
        previousUsername: user.previousUsername,
        deletionScheduledAt: user.deletionScheduledAt ?? null,
        deletionExecuteAt: user.deletionExecuteAt ?? null,
        providers: providers.map((p: OAuthProvider) => ({
          name: p.provider,
          profile: p.profile,
        })),
      },
    });
  } catch (error) {
    logger.error('Error fetching user profile:', error);
    return res.status(500).json({error: 'Failed to fetch user profile'});
  }
  }
);

// Update user profile
router.put(
  '/me',
  Auth.user(),
  ApiDoc({
    operationId: 'putProfileMe',
    summary: 'Update profile',
    description: 'Update username, nickname, or country for the current user',
    tags: ['Profile'],
    security: ['bearerAuth'],
    requestBody: {
      description: 'Optional username, nickname, country',
      schema: { type: 'object', properties: { username: { type: 'string' }, nickname: { type: 'string' }, country: { type: 'string' } } },
      required: false,
    },
    responses: {
      200: { description: 'Profile updated', schema: successMessageSchema },
      400: { description: 'Validation error', schema: errorResponseSchema },
      401: { description: 'Unauthorized', schema: errorResponseSchema },
      429: { description: 'Username change rate limit', schema: errorResponseSchema },
      500: { description: 'Server error', schema: errorResponseSchema },
    },
  }),
  async (req: Request, res: Response) => {
  let transaction: any;

  try {
    transaction = await sequelize.transaction();
    const username = req.body.username;
    const user = req.user;

    if (!user) {
      throw {'error': 'User not authenticated', 'code': 401};
    }

    if (req.body.username && req.body.username.length > 30) {
      throw {'error': 'Username must be less than 30 characters', 'code': 400};
    }

    if (req.body.username && req.body.username.length < 3) {
      throw {'error': 'Username must be at least 3 characters', 'code': 400};
    }

    // Validate username format: only alphanumeric characters and underscores
    if (req.body.username && !/^[a-zA-Z0-9_]+$/.test(req.body.username)) {
      throw {'error': 'Username can only contain letters, numbers, and underscores', 'code': 400};
    }

    if (req.body.nickname && req.body.nickname.length > 60) {
      throw {'error': 'Nickname must be less than 60 characters', 'code': 400};
    }

    if (req.body.nickname && req.body.nickname.length < 3) {
      throw {'error': 'Nickname must be at least 3 characters', 'code': 400};
    }
    // Check if nickname is being changed and validate uniqueness
    if (req.body.nickname && req.body.nickname !== user.nickname) {
      const existingPlayer = await Player.findOne({
        where: {
          name: req.body.nickname,
          id: { [Op.ne]: user.playerId } // Exclude current player
        },
        transaction
      });
      const existingUser = await User.findOne({
        where: {nickname: req.body.nickname},
        transaction
      });
      if (existingPlayer || existingUser) {
        throw {'error': 'Nickname already taken', 'code': 400};
      }
    }
    const targetPlayerName = req.body.nickname || user.player?.name || user.nickname;
    // Check if username is being changed
    if (username && username !== user.username) {
      // Check if username is taken
      const existingUser = await User.findOne({
        where: {username},
        transaction
      });

      if (existingUser) {
        throw {'error': 'Username already taken', 'code': 400};
      }

      // Check rate limit if user has changed username before
      if (user.lastUsernameChange) {
        const msSinceLastChange = Date.now() - new Date(user.lastUsernameChange).getTime();
        const msRemaining = usernameChangeCooldown - msSinceLastChange;

        if (msRemaining > 0) {
          const hours = Math.floor(msRemaining / (60 * 60 * 1000));
          const minutes = Math.floor((msRemaining % (60 * 60 * 1000)) / (60 * 1000));
          const seconds = Math.floor((msRemaining % (60 * 1000)) / 1000);

          const timeString = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
          const nextAvailableChange = new Date(user.lastUsernameChange.getTime() + usernameChangeCooldown);

          throw {
            error: `Username can only be changed once every ${usernameChangeCooldown / (24 * 60 * 60 * 1000)} days. Time remaining: ${timeString}`,
            nextAvailableChange: nextAvailableChange.toISOString(),
            timeRemaining: {
              hours,
              minutes,
              seconds,
              milliseconds: msRemaining,
              formatted: timeString
            },
            code: 429
          };
        }
      }

      // Create username change record
      await UsernameChange.create({
        userId: user.id,
        oldUsername: user.username,
        newUsername: username,
        updatedAt: new Date()
      }, { transaction });

      // Update user with new username and tracking info
      await User.update(
        {
          username,
          nickname: req.body.nickname,
          previousUsername: user.username,
          lastUsernameChange: new Date()
        },
        {
          where: {id: user.id},
          transaction
        }
      );
    } else {
      // Just update nickname if username isn't changing
      // Check if player name is being changed and validate uniqueness

      if (targetPlayerName !== user.player?.name) {
        const existingPlayer = await Player.findOne({
          where: {
            name: targetPlayerName,
            id: { [Op.ne]: user.playerId } // Exclude current player
          },
          transaction
        });
        if (existingPlayer) {
          throw {'error': 'Player name already taken', 'code': 400};
        }
      }
      await User.update(
        { nickname: targetPlayerName },
        {
          where: {id: user.id},
          transaction
        }
      );
      await Player.update(
        {
          name: targetPlayerName,
          country: req.body.country
        },
        {
          where: {id: user.playerId},
          transaction
        }
      );
    }

    // Fetch updated user data with providers
    const updatedUser = await User.findByPk(user.id, { transaction });
    const providers = await OAuthProvider.findAll({
      where: {userId: user.id},
      attributes: ['provider', 'profile'],
      transaction
    });

    if (!updatedUser) {
      throw {'error': 'User not found after update', 'code': 404};
    }

    await transaction.commit();

    // Update Elasticsearch after successful commit (don't fail request if this fails)
    try {
      await elasticsearchService.updatePlayerPasses(user.playerId!);
    } catch (elasticsearchError) {
      // Log but don't fail the request - the database update was successful
      logger.error('Error updating Elasticsearch after profile update:', elasticsearchError);
    }

    // Invalidate user-specific cache
    await CacheInvalidation.invalidateUser(user.id);

    return res.json({
      message: 'Profile updated successfully',
      user: {
        id: updatedUser.id,
        nickname: updatedUser.nickname || updatedUser.username,
        username: updatedUser.username,
        email: updatedUser.email,
        avatarUrl: updatedUser.avatarUrl,
        isRater: hasFlag(updatedUser, permissionFlags.RATER),
        isSuperAdmin: hasFlag(updatedUser, permissionFlags.SUPER_ADMIN),
        isRatingBanned: hasFlag(updatedUser, permissionFlags.RATING_BANNED),
        isEmailVerified: hasFlag(updatedUser, permissionFlags.EMAIL_VERIFIED),
        permissionFlags: updatedUser.permissionFlags,
        playerId: updatedUser.playerId,
        lastUsernameChange: updatedUser.lastUsernameChange,
        previousUsername: updatedUser.previousUsername,
        providers: providers.map((p: OAuthProvider) => p.provider),
      },
    });
  } catch (error: any) {
    await safeTransactionRollback(transaction);
    if (!error.code) {
      logger.error('Error updating user profile:', error);
    }
    return res.status(error.code || 500).json(error || 'Failed to update profile');
  }
  }
);

// Update password
router.put(
  '/password',
  Auth.user(),
  ApiDoc({
    operationId: 'putProfilePassword',
    summary: 'Change password',
    description: 'Update password for the authenticated user',
    tags: ['Profile'],
    security: ['bearerAuth'],
    requestBody: {
      description: 'Current and new password',
      schema: {
        type: 'object',
        properties: { currentPassword: { type: 'string' }, newPassword: { type: 'string' } },
        required: ['newPassword'],
      },
    },
    responses: {
      200: { description: 'Password updated', schema: successMessageSchema },
      400: { description: 'Validation error', schema: errorResponseSchema },
      401: { description: 'Unauthorized', schema: errorResponseSchema },
      500: { description: 'Server error', schema: errorResponseSchema },
    },
  }),
  async (req: Request, res: Response) => {
  try {
    const {currentPassword, newPassword} = req.body;
    const user = req.user;

    if (!user) {
      return res.status(401).json({error: 'User not authenticated'});
    }

    // If user has a password, verify current password
    if (user.password) {
      if (!currentPassword) {
        return res.status(400).json({error: 'Current password is required'});
      }

      const isValid = await bcrypt.compare(currentPassword, user.password);
      if (!isValid) {
        return res.status(400).json({error: 'Current password is incorrect'});
      }
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Update user's password
    await User.update({password: hashedPassword}, {where: {id: user.id}});

    // Invalidate user-specific cache
    await CacheInvalidation.invalidateUser(user.id);

    return res.json({message: 'Password updated successfully'});
  } catch (error) {
    logger.error('Error updating password:', error);
    return res.status(500).json({error: 'Failed to update password'});
  }
  }
);

// Upload avatar
router.post(
  '/avatar',
  Auth.user(),
  ApiDoc({
    operationId: 'postProfileAvatar',
    summary: 'Upload avatar',
    description: 'Upload profile avatar image (JPEG, PNG, WebP; max 10MB)',
    tags: ['Profile'],
    security: ['bearerAuth'],
    requestBody: { description: 'Multipart form with avatar file', required: true },
    responses: {
      200: { description: 'Avatar URL updated', schema: { type: 'object', properties: { avatarUrl: { type: 'string' } } } },
      400: { description: 'No file or invalid type', schema: errorResponseSchema },
      401: { description: 'Unauthorized', schema: errorResponseSchema },
      500: { description: 'Server error', schema: errorResponseSchema },
    },
  }),
  upload.single('avatar'),
  async (req: Request, res: Response) => {
    try {
        const user = req.user;
        if (!user) {
            return res.status(401).json({error: 'User not authenticated'});
        }

        if (!req.file) {
            return res.status(400).json({
                error: 'No file uploaded',
                code: 'NO_FILE'
            });
        }

        // Upload to CDN
        const result = await cdnService.uploadImage(
            req.file.buffer,
            req.file.originalname,
            'PROFILE'
        );
        try {
            if (user.avatarId) {
              if (await cdnService.checkFileExists(user.avatarId)) {
                await cdnService.deleteFile(user.avatarId);
              }
            }
        } catch (error) {
            logger.error('Error deleting old avatar from CDN:', error);
        }

        // Update user's avatar information
        await User.update(
            {
                avatarUrl: result.urls.original,
                avatarId: result.fileId
            },
            {where: {id: user.id}}
        );

        // Invalidate user-specific cache
        await CacheInvalidation.invalidateUser(user.id);

        return res.json({
            message: 'Avatar uploaded successfully',
            avatar: {
                id: result.fileId,
                urls: result.urls,
            }
        });
    } catch (error) {
        if (error instanceof CdnError) {
            return res.status(400).json({
                error: error.message,
                code: error.code,
                details: error.details
            });
        }

        return res.status(500).json({
            error: 'Failed to upload avatar',
            code: 'SERVER_ERROR',
            details: error instanceof Error ? error.message : String(error)
        });
    }
  }
);

// Remove avatar
router.delete(
  '/avatar',
  Auth.user(),
  ApiDoc({
    operationId: 'deleteProfileAvatar',
    summary: 'Remove avatar',
    description: 'Remove the current user profile avatar',
    tags: ['Profile'],
    security: ['bearerAuth'],
    responses: {
      200: { description: 'Avatar removed', schema: successMessageSchema },
      400: { description: 'No avatar to remove', schema: errorResponseSchema },
      401: { description: 'Unauthorized', schema: errorResponseSchema },
      500: { description: 'Server error', schema: errorResponseSchema },
    },
  }),
  async (req: Request, res: Response) => {
    try {
        const user = req.user;
        if (!user) {
            return res.status(401).json({error: 'User not authenticated'});
        }

        if (!user.avatarId) {
            return res.status(400).json({error: 'No avatar to remove'});
        }

        // Store the avatar ID before clearing it
        const oldAvatarId = user.avatarId;

        // Update user's avatar information first
        await User.update(
            {
                avatarUrl: null,
                avatarId: null
            },
            {where: {id: user.id}}
        );

        // Delete from CDN after updating user record
        try {
            await cdnService.deleteFile(oldAvatarId);
        } catch (error) {
            // Log the error but don't fail the request since user record is already updated
            logger.error('Error deleting old avatar from CDN:', error);
        }

        // Invalidate user-specific cache
        await CacheInvalidation.invalidateUser(user.id);

        return res.json({message: 'Avatar removed successfully'});
    } catch (error) {
        logger.error('Error removing avatar:', error);
        return res.status(500).json({error: 'Failed to remove avatar'});
    }
  }
);

function canUsePlayerCustomBanner(user: PermissionInput): boolean {
  return (
    hasFlag(user, permissionFlags.CUSTOM_PROFILE_BANNER) ||
    hasFlag(user, permissionFlags.SUPER_ADMIN)
  );
}

// --- Profile banner (preset + custom CDN) ---

router.patch(
  '/player/banner-preset',
  Auth.user(),
  ApiDoc({
    operationId: 'patchProfilePlayerBannerPreset',
    summary: 'Update player profile banner preset',
    tags: ['Profile'],
    security: ['bearerAuth'],
    responses: {
      200: { description: 'Updated' },
      400: { description: 'Invalid preset', schema: errorResponseSchema },
      401: { description: 'Unauthorized', schema: errorResponseSchema },
      500: { description: 'Server error', schema: errorResponseSchema },
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const user = req.user;
      if (!user?.playerId) {
        return res.status(400).json({ error: 'No player profile linked to this account' });
      }
      const body = req.body as { preset?: unknown };
      if (!Object.prototype.hasOwnProperty.call(body, 'preset')) {
        return res.status(400).json({ error: 'Request body must include preset (string or null)' });
      }
      let preset: string | null;
      try {
        preset = parseBannerPresetForStorage(body?.preset);
      } catch {
        return res.status(400).json({ error: 'Invalid banner preset' });
      }

      await Player.update({ bannerPreset: preset }, { where: { id: user.playerId } });
      await elasticsearchService.reindexPlayers([user.playerId]);
      await CacheInvalidation.invalidateUser(user.id);

      return res.json({ bannerPreset: preset });
    } catch (error) {
      logger.error('Error updating player banner preset:', error);
      return res.status(500).json({ error: 'Failed to update banner preset' });
    }
  },
);

router.delete(
  '/player/banner-preset',
  Auth.user(),
  ApiDoc({
    operationId: 'deleteProfilePlayerBannerPreset',
    summary: 'Clear player profile banner preset',
    tags: ['Profile'],
    security: ['bearerAuth'],
    responses: {
      200: { description: 'Cleared' },
      401: { description: 'Unauthorized', schema: errorResponseSchema },
      500: { description: 'Server error', schema: errorResponseSchema },
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const user = req.user;
      if (!user?.playerId) {
        return res.status(400).json({ error: 'No player profile linked to this account' });
      }

      await Player.update({ bannerPreset: null }, { where: { id: user.playerId } });
      await elasticsearchService.reindexPlayers([user.playerId]);
      await CacheInvalidation.invalidateUser(user.id);

      return res.json({ bannerPreset: null });
    } catch (error) {
      logger.error('Error clearing player banner preset:', error);
      return res.status(500).json({ error: 'Failed to clear banner preset' });
    }
  },
);

router.post(
  '/player/banner-custom',
  Auth.user(),
  upload.single('banner'),
  ApiDoc({
    operationId: 'postProfilePlayerBannerCustom',
    summary: 'Upload custom player profile banner',
    tags: ['Profile'],
    security: ['bearerAuth'],
    responses: {
      200: { description: 'Uploaded' },
      400: { description: 'No file or CDN error', schema: errorResponseSchema },
      401: { description: 'Unauthorized', schema: errorResponseSchema },
      403: { description: 'Forbidden', schema: errorResponseSchema },
      500: { description: 'Server error', schema: errorResponseSchema },
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const user = req.user;
      if (!user?.playerId) {
        return res.status(400).json({ error: 'No player profile linked to this account' });
      }
      if (!canUsePlayerCustomBanner(user as PermissionInput)) {
        return res.status(403).json({ error: 'Custom profile banners are not enabled for this account' });
      }
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded', code: 'NO_FILE' });
      }

      const player = await Player.findByPk(user.playerId);
      if (!player) {
        return res.status(404).json({ error: 'Player not found' });
      }

      const result = await cdnService.uploadImage(req.file.buffer, req.file.originalname, 'BANNER');
      const displayUrl = result.urls?.large ?? result.urls?.original ?? null;
      if (!displayUrl) {
        return res.status(500).json({ error: 'CDN did not return banner URLs' });
      }

      const oldId = player.customBannerId;
      await Player.update(
        { customBannerId: result.fileId, customBannerUrl: displayUrl },
        { where: { id: user.playerId } },
      );

      if (oldId && oldId !== result.fileId) {
        try {
          if (await cdnService.checkFileExists(oldId)) {
            await cdnService.deleteFile(oldId);
          }
        } catch (delErr) {
          logger.error('Error deleting previous player banner from CDN:', delErr);
        }
      }

      await elasticsearchService.reindexPlayers([user.playerId]);
      await CacheInvalidation.invalidateUser(user.id);

      return res.json({
        customBannerId: result.fileId,
        customBannerUrl: displayUrl,
      });
    } catch (error) {
      if (error instanceof CdnError) {
        return res.status(400).json({
          error: error.message,
          code: error.code,
          details: error.details,
        });
      }
      logger.error('Error uploading player banner:', error);
      return res.status(500).json({ error: 'Failed to upload banner' });
    }
  },
);

router.delete(
  '/player/banner-custom',
  Auth.user(),
  ApiDoc({
    operationId: 'deleteProfilePlayerBannerCustom',
    summary: 'Remove custom player profile banner',
    tags: ['Profile'],
    security: ['bearerAuth'],
    responses: {
      200: { description: 'Removed' },
      401: { description: 'Unauthorized', schema: errorResponseSchema },
      403: { description: 'Forbidden', schema: errorResponseSchema },
      500: { description: 'Server error', schema: errorResponseSchema },
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const user = req.user;
      if (!user?.playerId) {
        return res.status(400).json({ error: 'No player profile linked to this account' });
      }
      if (!canUsePlayerCustomBanner(user as PermissionInput)) {
        return res.status(403).json({ error: 'Custom profile banners are not enabled for this account' });
      }

      const player = await Player.findByPk(user.playerId);
      if (!player) {
        return res.status(404).json({ error: 'Player not found' });
      }

      const oldId = player.customBannerId;
      await Player.update({ customBannerId: null, customBannerUrl: null }, { where: { id: user.playerId } });

      if (oldId) {
        try {
          if (await cdnService.checkFileExists(oldId)) {
            await cdnService.deleteFile(oldId);
          }
        } catch (delErr) {
          logger.error('Error deleting player banner from CDN:', delErr);
        }
      }

      await elasticsearchService.reindexPlayers([user.playerId]);
      await CacheInvalidation.invalidateUser(user.id);

      return res.json({ customBannerId: null, customBannerUrl: null });
    } catch (error) {
      logger.error('Error removing player banner:', error);
      return res.status(500).json({ error: 'Failed to remove custom banner' });
    }
  },
);

// Schedule account deletion (3-day grace period)
router.post(
  '/me/delete',
  Auth.user(),
  ApiDoc({
    operationId: 'postProfileDeleteMe',
    summary: 'Schedule account deletion',
    description:
      'Schedules account deletion with a 3-day grace period. Immediately hides the player from the leaderboard.',
    tags: ['Profile'],
    security: ['bearerAuth'],
    responses: {
      200: {
        description: 'Deletion scheduled',
        schema: {
          type: 'object',
          properties: {
            message: { type: 'string' },
            deletionScheduledAt: { type: 'string' },
            deletionExecuteAt: { type: 'string' },
          },
        },
      },
      401: { description: 'Unauthorized', schema: errorResponseSchema },
      500: { description: 'Server error', schema: errorResponseSchema },
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const user = req.user;
      if (!user) return res.status(401).json({ error: 'User not authenticated' });

      const { deletionScheduledAt, deletionExecuteAt } =
        await accountDeletionService.scheduleDeletion(user.id);

      await CacheInvalidation.invalidateUser(user.id);

      return res.json({
        message: 'Account deletion scheduled',
        deletionScheduledAt: deletionScheduledAt.toISOString(),
        deletionExecuteAt: deletionExecuteAt.toISOString(),
      });
    } catch (error) {
      logger.error('Error scheduling account deletion:', error);
      return res.status(500).json({ error: 'Failed to schedule account deletion' });
    }
  },
);

// Cancel scheduled account deletion
router.post(
  '/me/delete/cancel',
  Auth.user(),
  ApiDoc({
    operationId: 'postProfileCancelDeleteMe',
    summary: 'Cancel account deletion',
    description:
      'Cancels a scheduled account deletion and restores permission flags and leaderboard ban state safely.',
    tags: ['Profile'],
    security: ['bearerAuth'],
    responses: {
      200: { description: 'Deletion canceled', schema: successMessageSchema },
      401: { description: 'Unauthorized', schema: errorResponseSchema },
      500: { description: 'Server error', schema: errorResponseSchema },
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const user = req.user;
      if (!user) return res.status(401).json({ error: 'User not authenticated' });

      await accountDeletionService.cancelDeletion(user.id);

      await CacheInvalidation.invalidateUser(user.id);

      return res.json({ message: 'Account deletion canceled' });
    } catch (error) {
      logger.error('Error canceling account deletion:', error);
      return res.status(500).json({ error: 'Failed to cancel account deletion' });
    }
  },
);

export default router;
