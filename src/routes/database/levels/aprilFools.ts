import { Router, Request, Response } from 'express';
import sequelize from '../../../config/db.js';
import Level from '../../../models/levels/Level.js';
import Difficulty from '../../../models/levels/Difficulty.js';
import { Auth } from '../../../middleware/auth.js';
import { handlePassUpdates, sanitizeTextInput } from './index.js';
import { getRandomSeed, seededShuffle } from '../../../utils/random.js';
import { Op } from 'sequelize';


const ENABLE_ROULETTE = process.env.APRIL_FOOLS === 'true';
const bigWheelTimeout = 1000 * 60 * 60 * 24 * 30; // 30 days
const individualLevelTimeout = 1000 * 60 * 60 * 24 * 30; // 30 days

const userTimeouts = new Map<string, number>();
const levelTimeouts = new Map<number, number>();

const checkUserTimeout = (userId: string): number | null => {
    const timeout = userTimeouts.get(userId);
    if (!timeout) return null;
    
    const now = Date.now();
    if (now >= timeout) {
      userTimeouts.delete(userId);
      return null;
    }
    
    return Math.ceil((timeout - now) / 1000);
  };

// Add check level timeout function
const checkLevelTimeout = (levelId: number): number | null => {
    const timeout = levelTimeouts.get(levelId);
    if (!timeout) return null;
    
    const remainingTime = timeout - Date.now();
    if (remainingTime <= 0) {
      levelTimeouts.delete(levelId);
      return null;
    }
    
    return Math.ceil(remainingTime / 1000);
  };
const router = Router();

router.put('/:id([0-9]+)/difficulty', Auth.verified(), async (req: Request, res: Response) => {
    if (!ENABLE_ROULETTE) {
      return res.status(727).json({ error: 'April fools over, roulette is disabled' });
    }
    const transaction = await sequelize.transaction();
  
    try {
      const levelId = parseInt(req.params.id);
      let { diffId, baseScore, publicComments } = req.body;
      
      // Sanitize text inputs
      publicComments = sanitizeTextInput(publicComments);
      
      if (!req.user) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
  
      // if (req.user?.player?.isBanned) {
      //   return res.status(403).json({ error: 'Your account is banned' });
      // }
  
      const timeoutDuration = bigWheelTimeout;
      const timeout = Date.now() + timeoutDuration;
      userTimeouts.set(req.user.id, timeout);
  
      if (isNaN(levelId) || !Number.isInteger(levelId) || levelId <= 0) {
        return res.status(400).json({ error: 'Invalid level ID' });
      }
  
      if (!diffId || !Number.isInteger(diffId) || diffId <= 0) {
        return res.status(400).json({ error: 'Invalid difficulty ID' });
      }
  
      if (!baseScore || !Number.isInteger(baseScore) || baseScore <= 0) {
        baseScore = null;
      }
  
      const difficulty = await Difficulty.findByPk(diffId, { transaction });
      if (!difficulty) {
        await transaction.rollback();
        return res.status(404).json({ error: 'Difficulty not found' });
      }
  
      const level = await Level.findByPk(levelId, { transaction });
      if (!level) {
        await transaction.rollback();
        return res.status(404).json({ error: 'Level not found' });
      }
  
      await level.update({
        diffId: diffId,
        baseScore: baseScore,
        previousDiffId: level.diffId,
        publicComments: publicComments
      }, { transaction });
  
      await transaction.commit();
  
      // Send immediate response
      const response = {
        message: 'Level difficulty updated successfully',
        level: {
          id: level.id,
          diffId: level.diffId,
          baseScore: baseScore,
          previousDiffId: level.previousDiffId,
          publicComments: level.publicComments
        },
        timeout: timeoutDuration / 1000
      };
      res.json(response);
  
      // Handle pass updates asynchronously
      handlePassUpdates(levelId, diffId, baseScore);
  
      return;
    } catch (error) {
      await transaction.rollback();
      console.error('Error updating level difficulty:', error);
      return res.status(500).json({ error: 'Failed to update level difficulty' });
    }
  });
  
  // Add new endpoint for level timeouts
  router.put('/:id([0-9]+)/timeout', Auth.verified(), async (req: Request, res: Response) => {
    if (!ENABLE_ROULETTE) {
      return res.status(727).json({ error: 'April fools over, roulette is disabled' });
    }
    const transaction = await sequelize.transaction();
    
    try {
      const levelId = parseInt(req.params.id);
      let { diffId, baseScore, publicComments } = req.body;
      
      // Sanitize text inputs
      publicComments = sanitizeTextInput(publicComments);
      
      if (!req.user) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
  
      // if (req.user?.player?.isBanned) {
      //   return res.status(403).json({ error: 'Your account is banned' });
      // }
  
      const timeoutDuration = individualLevelTimeout;
      const timeout = Date.now() + timeoutDuration;
      levelTimeouts.set(levelId, timeout);
  
      // Update level difficulty and base score
      await Level.update(
        {
          diffId,
          baseScore: baseScore || 0,
          publicComments: publicComments
        },
        {
          where: { id: levelId },
          transaction
        }
      );
  
      await transaction.commit();
  
      // Get updated level data
      const level = await Level.findByPk(levelId, {
        include: [
          {
            model: Difficulty,
            as: 'difficulty',
          },
        ]
      });
  
      // Send immediate response
      const response = {
        success: true,
        timeout: timeoutDuration / 1000,
        level: {
          id: levelId,
          diffId: level?.diffId,
          difficulty: level?.difficulty,
          baseScore: level?.baseScore,
          publicComments: level?.publicComments,
        }
      };
      res.json(response);
  
      // Handle pass updates asynchronously
      handlePassUpdates(levelId, diffId, baseScore);
  
      return;
    } catch (error) {
      await transaction.rollback();
      console.error('Error updating level timeout:', error);
      return res.status(500).json({ error: 'Failed to update level' });
    }
  });


  router.get('/all-levels', Auth.addUserToRequest(), async (req: Request, res: Response) => {
    if (!ENABLE_ROULETTE) {
      return res.status(727).json({ error: 'April fools over, roulette is disabled' });
    }
    try {
      if (req.user) {
        const remainingTime = checkUserTimeout(req.user.id);
        if (remainingTime !== null) {
          return res.json({
            timeout: true,
            remainingTime
          });
        }
      }
  
      // Generate a daily seed
      const seed = getRandomSeed();
      
      // Get all levels
      const levels = await Level.findAll({
        where: {
          isDeleted: false,
          isHidden: false,
          diffId: {
            [Op.ne]: 0
          }
        },
        include: [
          {
            model: Difficulty,
            as: 'difficulty',
            required: false,
            attributes: ['color', 'id']
          }
        ],
        attributes: ['id', 'song']
      });
  
      const modLevels = levels.filter(level => level.id % 4 === 0);
      // Shuffle array using seeded random
      const shuffledLevels = seededShuffle(modLevels, seed);
  
      // Transform the data to match slot machine format
      const slotItems = shuffledLevels.map(level => ({
        id: level.id,
        name: level.song,
        color: level.difficulty?.color || '#666666',
        diffId: level.difficulty?.id
      }));
  
      return res.json({
        items: slotItems,
        seed: seed
      });
    } catch (error) {
      console.error('Error fetching slot machine levels:', error);
      return res.status(500).json({ error: 'Failed to fetch slot machine levels' });
    }
  });

export default router;
