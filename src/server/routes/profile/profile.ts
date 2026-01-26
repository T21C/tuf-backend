import {Router, Request, Response} from 'express';
import {Auth} from '../../middleware/auth.js';
import {OAuthProvider, User} from '../../../models/index.js';
import bcrypt from 'bcrypt';
import sequelize from '../../../config/db.js';
import { Op } from 'sequelize';
import UsernameChange from '../../../models/auth/UsernameChange.js';
import Player from '../../../models/players/Player.js';
import { logger } from '../../services/LoggerService.js';
import multer from 'multer';
import cdnService from '../../services/CdnService.js';
import { CdnError } from '../../services/CdnService.js';
import PlayerStats from '../../../models/players/PlayerStats.js';
import Difficulty from '../../../models/levels/Difficulty.js';
import { safeTransactionRollback } from '../../../misc/utils/Utility.js';
import ElasticsearchService from '../../services/ElasticsearchService.js';
import { hasFlag } from '../../../misc/utils/auth/permissionUtils.js';
import { permissionFlags } from '../../../config/constants.js';

const router: Router = Router();
const elasticsearchService = ElasticsearchService.getInstance();

const usernameChangeCooldown = 3 * 24 * 60 * 60 * 1000; // 3 days

// Configure multer for memory storage
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 10 * 1024 * 1024, // 10MB limit
    },
    fileFilter: (req, file, cb) => {
        const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Only JPEG, PNG and WebP are allowed.'));
        }
    }
});

// Get current user profile
router.get('/me', Auth.user(), async (req: Request, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({error: 'User not authenticated'});
    }

    // Fetch providers with profile data
    const providers = await OAuthProvider.findAll({
      where: {userId: user.id},
      attributes: ['provider', 'providerId', 'profile'],
    });

    const player = await Player.findByPk(user.playerId, {
      include: [
        {
          model: PlayerStats,
          as: 'stats',
          include: [
            {
              model: Difficulty,
              as: 'topDiff',
            },
            {
              model: Difficulty,
              as: 'top12kDiff',
            },
          ],
        },
      ],
    });

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
});

// Update user profile
router.put('/me', Auth.user(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();

  try {
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
      attributes: ['provider', 'providerId', 'profile'],
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
});

// Update password
router.put('/password', Auth.user(), async (req: Request, res: Response) => {
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

    return res.json({message: 'Password updated successfully'});
  } catch (error) {
    logger.error('Error updating password:', error);
    return res.status(500).json({error: 'Failed to update password'});
  }
});

// Upload avatar
router.post('/avatar', Auth.user(), upload.single('avatar'), async (req: Request, res: Response) => {
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
});

// Remove avatar
router.delete('/avatar', Auth.user(), async (req: Request, res: Response) => {
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

        return res.json({message: 'Avatar removed successfully'});
    } catch (error) {
        logger.error('Error removing avatar:', error);
        return res.status(500).json({error: 'Failed to remove avatar'});
    }
});

export default router;
