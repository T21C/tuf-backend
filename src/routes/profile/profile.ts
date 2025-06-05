import {Router, Request, Response} from 'express';
import {Auth} from '../../middleware/auth.js';
import {OAuthProvider, User} from '../../models/index.js';
import bcrypt from 'bcrypt';
import sequelize from "../../config/db.js";
import UsernameChange from '../../models/auth/UsernameChange.js';
import Player from '../../models/players/Player.js';
import { logger } from '../../services/LoggerService.js';
import multer from 'multer';
import cdnService from '../../services/CdnService.js';
import { CdnError } from '../../services/CdnService.js';

const router: Router = Router();

// Configure multer for memory storage
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 5 * 1024 * 1024, // 5MB limit
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
      attributes: ['pfp'],
    });

    return res.json({
      user: {
        id: user.id,
        username: user.username,
        nickname: user.nickname || user.username,
        email: user.email,
        avatarUrl: user.avatarUrl,
        isRater: user.isRater,
        isSuperAdmin: user.isSuperAdmin,
        isRatingBanned: user.isRatingBanned,
        isEmailVerified: user.isEmailVerified,
        playerId: user.playerId,
        password: user.password ? true : null,
        pfp: player?.pfp,
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
    const username = ""; //req.body;
    const user = req.user;

    if (!user) {
      return res.status(401).json({error: 'User not authenticated'});
    }

    // Check if username is being changed
    if (username && username !== user.username) {
      // Check if username is taken
      const existingUser = await User.findOne({
        where: {username},
        transaction
      });
      
      if (existingUser) {
        await transaction.rollback();
        return res.status(400).json({error: 'Username already taken'});
      }

      // Check rate limit if user has changed username before
      if (user.lastUsernameChange) {
        const msSinceLastChange = Date.now() - new Date(user.lastUsernameChange).getTime();
        const msRemaining = (24 * 60 * 60 * 1000) - msSinceLastChange;
        
        if (msRemaining > 0) {
          const hours = Math.floor(msRemaining / (60 * 60 * 1000));
          const minutes = Math.floor((msRemaining % (60 * 60 * 1000)) / (60 * 1000));
          const seconds = Math.floor((msRemaining % (60 * 1000)) / 1000);
          
          const timeString = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
          const nextAvailableChange = new Date(user.lastUsernameChange.getTime() + (24 * 60 * 60 * 1000));
          
          await transaction.rollback();
          return res.status(429).json({
            error: `Username can only be changed once every 24 hours. Time remaining: ${timeString}`,
            nextAvailableChange,
            timeRemaining: {
              hours,
              minutes,
              seconds,
              formatted: timeString
            }
          });
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
      await User.update(
        { nickname: req.body.nickname },
        {
          where: {id: user.id},
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
      await transaction.rollback();
      return res.status(404).json({error: 'User not found after update'});
    }

    await transaction.commit();

    return res.json({
      message: 'Profile updated successfully',
      user: {
        id: updatedUser.id,
        nickname: updatedUser.nickname || updatedUser.username,
        username: updatedUser.username,
        email: updatedUser.email,
        avatarUrl: updatedUser.avatarUrl,
        isRater: updatedUser.isRater,
        isSuperAdmin: updatedUser.isSuperAdmin,
        isRatingBanned: updatedUser.isRatingBanned,
        playerId: updatedUser.playerId,
        lastUsernameChange: updatedUser.lastUsernameChange,
        previousUsername: updatedUser.previousUsername,
        providers: providers.map((p: OAuthProvider) => p.provider),
      },
    });
  } catch (error) {
    await transaction.rollback();
    logger.error('Error updating user profile:', error);
    return res.status(500).json({error: 'Failed to update profile'});
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
        logger.error('Error uploading avatar:', error);
        
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
