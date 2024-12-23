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
    const { id, name } = req.body;
    
    if (!id || !name) {
      return res.status(400).json({ error: 'ID and name are required' });
    }

    // Check if rater already exists
    const existingRater = await RaterService.getById(id);
    if (existingRater) {
      return res.status(400).json({ error: 'Rater already exists' });
    }

    // Fetch Discord info
    try {
      const discordInfo = await fetchDiscordUserInfo(id);
      const rater = await RaterService.create({
        discordId: id,
        name,
        discordUsername: discordInfo.username,
        discordAvatar: discordInfo.avatar || undefined
      });
      return res.status(201).json(rater);
    } catch (discordError) {
      console.error('Failed to fetch Discord info:', discordError);
      // Create rater without Discord info if fetch fails
      const rater = await RaterService.create({
        discordId: id,
        name
      });
      return res.status(201).json(rater);
    }
  } catch (error) {
    console.error('Failed to create rater:', error);
    return res.status(500).json({ error: 'Failed to create rater' });
  }
});

// Delete rater (admin only)
router.delete('/:id', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
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

// Update raters' Discord info (admin only)
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

export default router; 