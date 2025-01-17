import express, { Router, Request, Response } from 'express';
import Difficulty from '../../models/Difficulty';
import Level from '../../models/Level';
import { Auth } from '../../middleware/auth';
import { Op } from 'sequelize';
import { IDifficulty } from '../../interfaces/models';
import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// Fix __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Cache directory path
const ICON_CACHE_DIR = path.join(__dirname, '../../../cache/icons');
const IMAGE_API = process.env.IMAGE_API || '/api/images';
const OWN_URL = process.env.NODE_ENV === 'production' 
? process.env.PROD_API_URL 
: process.env.NODE_ENV === 'staging'
? process.env.STAGING_API_URL
: process.env.NODE_ENV === 'development'
? process.env.OWN_URL
: 'http://localhost:3002';

// Helper function to download and cache icons
async function cacheIcon(iconUrl: string, diffName: string): Promise<string> {
  try {
    await fs.mkdir(ICON_CACHE_DIR, { recursive: true });
    const fileName = `${diffName.replace(/[^a-zA-Z0-9]/g, '_')}.png`;
    const filePath = path.join(ICON_CACHE_DIR, fileName);
    const newUrl = `${OWN_URL}${IMAGE_API}/icon/${fileName}`;

    // Always attempt to cache the icon, even if it's already a cached URL
    try {
      const response = await axios.get(iconUrl, { responseType: 'arraybuffer' });
      await fs.writeFile(filePath, Buffer.from(response.data));
    } catch (error) {
      console.error(`Failed to cache icon for ${diffName}:`, error);
      // If caching fails but file exists, continue using existing cache
      if (!(await fs.stat(filePath).catch(() => false))) {
        throw error; // Re-throw if no cached file exists
      }
    }

    return newUrl;
  } catch (error) {
    console.error(`Failed to process icon for ${diffName}:`, error);
    return iconUrl; // Return original URL as fallback
  }
}

const router: Router = express.Router();

// Get all difficulties
router.get('/', async (req, res) => {
  try {
    const diffs = await Difficulty.findAll();
    const diffsList = diffs.map(diff => diff.toJSON());
    res.json(diffsList);
  } catch (error) {
    console.error('Error fetching difficulties:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create new difficulty
router.post('/', [Auth.superAdmin(), Auth.superAdminPassword()], async (req: Request, res: Response) => {
  try {
    const {
      id,
      name,
      type,
      icon,
      emoji,
      color,
      baseScore,
      sortOrder,
      legacy,
      legacyIcon,
      legacyEmoji,
      superAdminPassword
    } = req.body;

    // Check for duplicate ID
    const existingDiffId = await Difficulty.findByPk(id);
    if (existingDiffId) {
      return res.status(400).json({ error: 'A difficulty with this ID already exists' });
    }

    // Check for duplicate name
    const existingDiffName = await Difficulty.findOne({ where: { name } });
    if (existingDiffName) {
      return res.status(400).json({ error: 'A difficulty with this name already exists' });
    }

    // Cache icons
    const cachedIcon = await cacheIcon(icon, name);
    const cachedLegacyIcon = legacyIcon ? await cacheIcon(legacyIcon, `legacy_${name}`) : null;

    const difficulty = await Difficulty.create({
      id,
      name,
      type,
      icon: cachedIcon,
      emoji,
      color,
      baseScore,
      sortOrder,
      legacy,
      legacyIcon: cachedLegacyIcon,
      legacyEmoji,
      createdAt: new Date(),
      updatedAt: new Date()
    } as IDifficulty);

    return res.status(201).json(difficulty);
  } catch (error) {
    console.error('Error creating difficulty:', error);
    return res.status(500).json({ error: 'Failed to create difficulty' });
  }
});

// Update difficulty
router.put('/:id', [Auth.superAdmin(), Auth.superAdminPassword()], async (req: Request, res: Response) => {
  try {
    const diffId = parseInt(req.params.id);
    const {
      name,
      type,
      icon,
      emoji,
      color,
      baseScore,
      sortOrder,
      legacy,
      legacyIcon,
      legacyEmoji,
      superAdminPassword
    } = req.body;

    const difficulty = await Difficulty.findByPk(diffId);
    if (!difficulty) {
      return res.status(404).json({ error: 'Difficulty not found' });
    }

    // Check for name duplication if name is being changed
    if (name && name !== difficulty.name) {
      const existingDiffName = await Difficulty.findOne({ where: { name } });
      if (existingDiffName) {
        return res.status(400).json({ error: 'A difficulty with this name already exists' });
      }
    }

    // Cache new icons if provided
    const cachedIcon = icon && icon !== difficulty.icon ? await cacheIcon(icon, name || difficulty.name) : difficulty.icon;
    const cachedLegacyIcon = legacyIcon && legacyIcon !== difficulty.legacyIcon ? 
      await cacheIcon(legacyIcon, `legacy_${name || difficulty.name}`) : 
      difficulty.legacyIcon;

    // Update the difficulty with nullish coalescing
    await difficulty.update({
      name: name ?? difficulty.name,
      type: type ?? difficulty.type,
      icon: cachedIcon,
      emoji: emoji ?? difficulty.emoji,
      color: color ?? difficulty.color,
      baseScore: baseScore ?? difficulty.baseScore,
      sortOrder: sortOrder ?? difficulty.sortOrder,
      legacy: legacy ?? difficulty.legacy,
      legacyIcon: cachedLegacyIcon,
      legacyEmoji: legacyEmoji ?? difficulty.legacyEmoji,
      updatedAt: new Date()
    });

    return res.json(difficulty);
  } catch (error) {
    console.error('Error updating difficulty:', error);
    return res.status(500).json({ error: 'Failed to update difficulty' });
  }
});

// Delete difficulty with fallback
router.delete('/:id', [Auth.superAdmin(), Auth.superAdminPassword()], async (req: Request, res: Response) => {
  try {
    const diffId = parseInt(req.params.id);
    const fallbackDiffId = parseInt(req.query.fallbackId as string);
    const { superAdminPassword } = req.body;

    if (fallbackDiffId === undefined || fallbackDiffId === null) {
      return res.status(400).json({ error: 'Fallback difficulty ID is required' });
    }

    const difficulty = await Difficulty.findByPk(diffId);
    if (!difficulty) {
      return res.status(404).json({ error: 'Difficulty to delete not found' });
    }

    const fallbackDifficulty = await Difficulty.findByPk(fallbackDiffId);
    if (!fallbackDifficulty) {
      return res.status(404).json({ error: 'Fallback difficulty not found' });
    }

    if (diffId === fallbackDiffId) {
      return res.status(400).json({ error: 'Fallback difficulty cannot be the same as the difficulty to delete' });
    }

    // Begin transaction
    const transaction = await Difficulty.sequelize!.transaction();

    try {
      // First, update all levels that use this difficulty to use the fallback
      await Level.update(
        { diffId: fallbackDiffId },
        { 
          where: { diffId: diffId },
          transaction
        }
      );

      // Then delete the difficulty
      await difficulty.destroy({ transaction });

      // Commit transaction
      await transaction.commit();

      return res.json({ 
        message: 'Difficulty deleted successfully',
        updatedLevels: await Level.count({ where: { diffId: fallbackDiffId } })
      });
    } catch (error) {
      // Rollback transaction on error
      await transaction.rollback();
      throw error;
    }
  } catch (error) {
    console.error('Error deleting difficulty:', error);
    return res.status(500).json({ error: 'Failed to delete difficulty' });
  }
});

export default router;
