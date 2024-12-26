import { Router, Request, Response } from 'express';
import { Rater, RaterService } from '../../services/RaterService';
import { Auth } from '../../middleware/auth';
import { fetchDiscordUserInfo } from '../../utils/discord';

const router: Router = Router();

// Get all raters
router.get('/', async (req: Request, res: Response) => {
  try {
    const raters = await RaterService.getAll();
    return res.json(raters);
  } catch (error) {
    console.error('Failed to fetch raters:', error);
    return res.status(500).json({ error: 'Failed to fetch raters' });
  }
});

// Create new rater (admin only)
router.post('/', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    const { discordId } = req.body;
    
    if (!discordId) {
      return res.status(400).json({ error: 'Discord ID is required' });
    }

    // Check if rater already exists
    const existingRater = await RaterService.getById(discordId);
    if (existingRater) {
      return res.status(400).json({ error: 'Rater already exists' });
    }

    // Fetch Discord info
    try {
      const discordInfo = await fetchDiscordUserInfo(discordId);
      const rater = await RaterService.create({
        discordId,
        discordUsername: discordInfo.username,
        discordAvatar: discordInfo.avatar || undefined
      });
      console.log(rater);
      return res.status(201).json(rater);
    } catch (discordError) {
      console.error('Failed to fetch Discord info:', discordError);
      return res.status(400).json({ error: 'Failed to fetch Discord info for the provided ID' });
    }
  } catch (error) {
    console.error('Failed to create rater:', error);
    return res.status(500).json({ error: 'Failed to create rater' });
  }
});

// Delete rater
router.delete('/:id', [Auth.superAdmin(), Auth.superAdminPassword()], async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    // Get rater info first to check if they're a super admin
    const rater = await RaterService.getById(id);
    if (!rater) {
      return res.status(404).json({ error: 'Rater not found' });
    }

    // If target is a super admin, use the password-protected middleware
    if (rater.isSuperAdmin) {
      req.body.targetRater = rater;
    }

    const rowsDeleted = await RaterService.deleteById(id);
    if (rowsDeleted === 0) {
      return res.status(404).json({ error: 'Rater not found' });
    }
    
    return res.json({ message: 'Rater deleted successfully' });
  } catch (error) {
    console.error('Failed to delete rater:', error);
    return res.status(500).json({ error: 'Failed to delete rater' });
  }
});

// Update rater's Discord info
router.put('/:id/discord', [Auth.superAdmin(), Auth.superAdminPassword()], async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { discordId, discordUsername, discordAvatar } = req.body;

    // Get rater info first to check if they're a super admin
    const rater = await RaterService.getById(id);
    if (!rater) {
      return res.status(404).json({ error: 'Rater not found' });
    }

    // If target is a super admin, use the password-protected middleware
    if (rater.isSuperAdmin) {
      req.body.targetRater = rater;
    }

    await RaterService.updateDiscordInfo(id, discordUsername, discordAvatar);
    return res.json({ message: 'Discord info updated successfully' });
  } catch (error) {
    console.error('Failed to update Discord info:', error);
    return res.status(500).json({ error: 'Failed to update Discord info' });
  }
});

// Update all raters' Discord info
router.post('/update-discord-info', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    const raterIds = await RaterService.getAllIds();
    const updates = [];
    const errors = [];

    for (const id of raterIds) {
      try {
        const discordInfo = await fetchDiscordUserInfo(id);
        if (discordInfo.username) {
          updates.push({
            id,
            discordUsername: discordInfo.username,
            discordAvatar: discordInfo.avatar || ''
          });
        }
      } catch (error) {
        console.error(`Failed to fetch Discord info for ${id}:`, error);
        errors.push(id);
      }
    }

    if (updates.length > 0) {
      await RaterService.bulkUpdateDiscordInfo(updates);
    }

    return res.json({
      message: 'Raters updated successfully',
      updatedCount: updates.length,
      failedIds: errors
    });
  } catch (error) {
    console.error('Failed to update raters:', error);
    return res.status(500).json({ error: 'Failed to update raters' });
  }
});

// Check if user is a rater
router.get('/check/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const isRater = await RaterService.isRater(id);
    return res.json({ isRater });
  } catch (error) {
    console.error('Failed to check rater status:', error);
    return res.status(500).json({ error: 'Failed to check rater status' });
  }
});

// Update rater's super admin status
router.put('/:id/super-admin', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { isSuperAdmin, superAdminPassword } = req.body;

    if (!superAdminPassword || superAdminPassword !== process.env.SUPER_ADMIN_KEY) {
      return res.status(403).json({ error: 'Invalid password' });
    }

    // Get rater info first
    const rater = await RaterService.getById(id);
    if (!rater) {
      return res.status(404).json({ error: 'Rater not found' });
    }

    // Update super admin status
    await RaterService.updateSuperAdminStatus(id, isSuperAdmin);
    return res.json({ message: 'Super admin status updated successfully' });
  } catch (error) {
    console.error('Failed to update super admin status:', error);
    return res.status(500).json({ error: 'Failed to update super admin status' });
  }
});

export default router; 