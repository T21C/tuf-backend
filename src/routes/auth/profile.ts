import {Router, Request, Response} from 'express';
import {Auth} from '../../middleware/auth.js';
import {OAuthProvider, User} from '../../models/index.js';
import bcrypt from 'bcrypt';

const router: Router = Router();

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

    return res.json({
      user: {
        id: user.id,
        username: user.username,
        nickname: user.nickname || user.username,
        email: user.email,
        avatarUrl: user.avatarUrl,
        isRater: user.isRater,
        isSuperAdmin: user.isSuperAdmin,
        playerId: user.playerId,
        password: user.password ? true : null,
        providers: providers.map(p => ({
          name: p.provider,
          profile: p.profile,
        })),
      },
    });
  } catch (error) {
    console.error('Error fetching user profile:', error);
    return res.status(500).json({error: 'Failed to fetch user profile'});
  }
});

// Update user profile
router.put('/me', Auth.user(), async (req: Request, res: Response) => {
  try {
    const {username, email} = req.body;
    const user = req.user;

    if (!user) {
      return res.status(401).json({error: 'User not authenticated'});
    }

    // Check if username is taken
    if (username && username !== user.username) {
      const existingUser = await User.findOne({where: {username}});
      if (existingUser) {
        return res.status(400).json({error: 'Username already taken'});
      }
    }

    // Check if email is taken
    if (email && email !== user.email) {
      const existingUser = await User.findOne({where: {email}});
      if (existingUser) {
        return res.status(400).json({error: 'Email already taken'});
      }
    }

    // Update user
    await User.update(
      {username, email, nickname: req.body.nickname},
      {where: {id: user.id}},
    );

    // Fetch updated user data with providers
    const updatedUser = await User.findByPk(user.id);
    const providers = await OAuthProvider.findAll({
      where: {userId: user.id},
      attributes: ['provider', 'providerId', 'profile'],
    });

    if (!updatedUser) {
      return res.status(404).json({error: 'User not found after update'});
    }

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
        playerId: updatedUser.playerId,
        providers: providers.map(p => p.provider),
      },
    });
  } catch (error) {
    console.error('Error updating user profile:', error);
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
    console.error('Error updating password:', error);
    return res.status(500).json({error: 'Failed to update password'});
  }
});

export default router;
