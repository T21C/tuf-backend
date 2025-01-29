import express, {Router, Request, Response} from 'express';
import Difficulty from '../../models/Difficulty.js';
import Level from '../../models/Level.js';
import Pass from '../../models/Pass.js';
import Judgement from '../../models/Judgement.js';
import {Auth} from '../../middleware/auth.js';
import {Op} from 'sequelize';
import {IDifficulty} from '../../interfaces/models/index.js';
import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import {fileURLToPath} from 'url';
import {dirname} from 'path';
import {getIO} from '../../utils/socket.js';
import {sseManager} from '../../utils/sse.js';
import {getScoreV2} from '../../misc/CalcScore.js';
import {PlayerStatsService} from '../../services/PlayerStatsService.js';
import sequelize from '../../config/db.js';

const playerStatsService = PlayerStatsService.getInstance();

// Fix __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Cache directory path
const ICON_CACHE_DIR = path.join(__dirname, '../../../cache/icons');
const IMAGE_API = process.env.IMAGE_API || '/api/images';
const ownUrlEnv =
  process.env.NODE_ENV === 'production'
    ? process.env.PROD_API_URL
    : process.env.NODE_ENV === 'staging'
      ? process.env.STAGING_API_URL
      : process.env.NODE_ENV === 'development'
        ? process.env.DEV_URL
        : 'http://localhost:3002';

// Helper function to download and cache icons
async function cacheIcon(iconUrl: string, diffName: string): Promise<string> {
  try {
    await fs.mkdir(ICON_CACHE_DIR, {recursive: true});
    const fileName = `${diffName.replace(/[^a-zA-Z0-9]/g, '_')}.png`;
    const filePath = path.join(ICON_CACHE_DIR, fileName);
    const newUrl = `${ownUrlEnv}${IMAGE_API}/icon/${fileName}`;

    // Always attempt to cache the icon, even if it's already a cached URL
    try {
      const response = await axios.get(iconUrl, {responseType: 'arraybuffer'});
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
    res.status(500).json({error: 'Internal server error'});
  }
});

// Create new difficulty
router.post(
  '/',
  [Auth.superAdmin(), Auth.superAdminPassword()],
  async (req: Request, res: Response) => {
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
      } = req.body;

      // Check for duplicate ID
      const existingDiffId = await Difficulty.findByPk(id);
      if (existingDiffId) {
        return res
          .status(400)
          .json({error: 'A difficulty with this ID already exists'});
      }

      // Check for duplicate name
      const existingDiffName = await Difficulty.findOne({where: {name}});
      if (existingDiffName) {
        return res
          .status(400)
          .json({error: 'A difficulty with this name already exists'});
      }

      // Cache icons
      const cachedIcon = await cacheIcon(icon, name);
      const cachedLegacyIcon = legacyIcon
        ? await cacheIcon(legacyIcon, `legacy_${name}`)
        : null;

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
        updatedAt: new Date(),
      } as IDifficulty);

      return res.status(201).json(difficulty);
    } catch (error) {
      console.error('Error creating difficulty:', error);
      return res.status(500).json({error: 'Failed to create difficulty'});
    }
  },
);

// Update difficulty
router.put(
  '/:id',
  [Auth.superAdmin(), Auth.superAdminPassword()],
  async (req: Request, res: Response) => {
    const transaction = await sequelize.transaction();
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
      } = req.body;

      const difficulty = await Difficulty.findByPk(diffId);
      if (!difficulty) {
        await transaction.rollback();
        return res.status(404).json({error: 'Difficulty not found'});
      }

      // Check for name duplication if name is being changed
      if (name && name !== difficulty.name) {
        const existingDiffName = await Difficulty.findOne({where: {name}});
        if (existingDiffName) {
          await transaction.rollback();
          return res
            .status(400)
            .json({error: 'A difficulty with this name already exists'});
        }
      }

      // Cache new icons if provided
      const cachedIcon =
        icon && icon !== difficulty.icon
          ? await cacheIcon(icon, name || difficulty.name)
          : difficulty.icon;
      const cachedLegacyIcon =
        legacyIcon && legacyIcon !== difficulty.legacyIcon
          ? await cacheIcon(legacyIcon, `legacy_${name || difficulty.name}`)
          : difficulty.legacyIcon;

      // Check if base score is being changed
      const isBaseScoreChanged =
        baseScore !== undefined && baseScore !== difficulty.baseScore;

      // Update the difficulty with nullish coalescing
      await difficulty.update(
        {
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
          updatedAt: new Date(),
        },
        {transaction},
      );

      // If base score changed, recalculate scores for all affected passes
      let affectedPasses: Pass[] = [];
      const affectedPlayerIds: Set<number> = new Set();

      if (isBaseScoreChanged) {
        // Get all levels with this difficulty
        const levels = await Level.findAll({
          where: {diffId: diffId},
          transaction,
        });

        const levelIds = levels.map(level => level.id);

        // Get all non-deleted passes for these levels
        affectedPasses = await Pass.findAll({
          where: {
            levelId: {[Op.in]: levelIds},
            isDeleted: false,
          },
          include: [
            {
              model: Level,
              as: 'level',
              include: [
                {
                  model: Difficulty,
                  as: 'difficulty',
                },
              ],
            },
            {
              model: Judgement,
              as: 'judgements',
            },
          ],
          transaction,
        });

        // Recalculate scores for each pass
        for (const pass of affectedPasses) {
          if (!pass.level || !pass.level.difficulty || !pass.judgements)
            continue;

          const levelData = {
            baseScore: pass.level.baseScore,
            difficulty: pass.level.difficulty,
          };

          const passData = {
            speed: pass.speed || 1.0,
            judgements: pass.judgements,
            isNoHoldTap: pass.isNoHoldTap || false,
          };

          const newScore = getScoreV2(passData, levelData);

          await pass.update(
            {
              scoreV2: newScore,
            },
            {transaction},
          );

          // Collect affected player IDs
          if (pass.playerId) {
            affectedPlayerIds.add(pass.playerId);
          }
        }

        // Update level stats
        await Promise.all(
          levelIds.map(levelId =>
            Level.update(
              {isCleared: affectedPasses.some(p => p.levelId === levelId)},
              {where: {id: levelId}, transaction},
            ),
          ),
        );
      }

      // Commit the transaction first to ensure all updates are saved
      await transaction.commit();

      // If base score was changed, reload all stats after the transaction is committed
      if (isBaseScoreChanged) {
        try {
          // Reload all stats since this is a critical update affecting scores
          await playerStatsService.reloadAllStats();

          // Emit events for frontend updates after stats are reloaded
          const io = getIO();
          io.emit('leaderboardUpdated');
          io.emit('difficultyUpdated', {difficultyId: diffId});

          // Broadcast SSE events
          sseManager.broadcast({
            type: 'difficultyUpdate',
            data: {
              difficultyId: diffId,
              action: 'update',
              affectedPasses: affectedPasses.length,
              affectedPlayers: affectedPlayerIds.size,
            },
          });
        } catch (error) {
          console.error('Error reloading stats:', error);
          return res.status(500).json({
            error:
              'Difficulty updated but failed to reload stats. Please reload manually.',
            details: error instanceof Error ? error.message : String(error),
          });
        }
      } else {
        // If no base score change, just emit the difficulty update
        const io = getIO();
        io.emit('difficultyUpdated', {difficultyId: diffId});

        sseManager.broadcast({
          type: 'difficultyUpdate',
          data: {
            difficultyId: diffId,
            action: 'update',
            affectedPasses: 0,
            affectedPlayers: 0,
          },
        });
      }

      return res.json(difficulty);
    } catch (error) {
      await transaction.rollback();
      console.error('Error updating difficulty:', error);
      return res.status(500).json({error: 'Failed to update difficulty'});
    }
  },
);

// Delete difficulty with fallback
router.delete(
  '/:id',
  [Auth.superAdmin(), Auth.superAdminPassword()],
  async (req: Request, res: Response) => {
    try {
      const diffId = parseInt(req.params.id);
      const fallbackDiffId = parseInt(req.query.fallbackId as string);

      if (fallbackDiffId === undefined || fallbackDiffId === null) {
        return res
          .status(400)
          .json({error: 'Fallback difficulty ID is required'});
      }

      const difficulty = await Difficulty.findByPk(diffId);
      if (!difficulty) {
        return res.status(404).json({error: 'Difficulty to delete not found'});
      }

      const fallbackDifficulty = await Difficulty.findByPk(fallbackDiffId);
      if (!fallbackDifficulty) {
        return res.status(404).json({error: 'Fallback difficulty not found'});
      }

      if (diffId === fallbackDiffId) {
        return res.status(400).json({
          error:
            'Fallback difficulty cannot be the same as the difficulty to delete',
        });
      }

      // Begin transaction
      const transaction = await Difficulty.sequelize!.transaction();

      try {
        // First, update all levels that use this difficulty to use the fallback
        await Level.update(
          {diffId: fallbackDiffId},
          {
            where: {diffId: diffId},
            transaction,
          },
        );

        // Then delete the difficulty
        await difficulty.destroy({transaction});

        // Commit transaction
        await transaction.commit();

        return res.json({
          message: 'Difficulty deleted successfully',
          updatedLevels: await Level.count({where: {diffId: fallbackDiffId}}),
        });
      } catch (error) {
        // Rollback transaction on error
        await transaction.rollback();
        throw error;
      }
    } catch (error) {
      console.error('Error deleting difficulty:', error);
      return res.status(500).json({error: 'Failed to delete difficulty'});
    }
  },
);

export default router;
