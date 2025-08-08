import express, {Router, Request, Response} from 'express';
import Difficulty from '../../models/levels/Difficulty.js';
import Level from '../../models/levels/Level.js';
import Pass from '../../models/passes/Pass.js';
import Judgement from '../../models/passes/Judgement.js';
import {Auth} from '../../middleware/auth.js';
import {Op} from 'sequelize';
import {DirectiveCondition, IDifficulty} from '../../interfaces/models/index.js';
import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import {fileURLToPath} from 'url';
import {dirname} from 'path';
import {getIO} from '../../utils/socket.js';
import {sseManager} from '../../utils/sse.js';
import {getScoreV2} from '../../utils/CalcScore.js';
import {PlayerStatsService} from '../../services/PlayerStatsService.js';
import sequelize from '../../config/db.js';
import AnnouncementDirective from '../../models/announcements/AnnouncementDirective.js';
import AnnouncementChannel from '../../models/announcements/AnnouncementChannel.js';
import AnnouncementRole from '../../models/announcements/AnnouncementRole.js';
import DirectiveAction from '../../models/announcements/DirectiveAction.js';
import { DirectiveParser } from '../../utils/directiveParser.js';
import crypto from 'crypto';
import { logger } from '../../services/LoggerService.js';
import LevelRerateHistory from '../../models/levels/LevelRerateHistory.js';
import { safeTransactionRollback } from '../../utils/Utility.js';

const playerStatsService = PlayerStatsService.getInstance();

// Store the current hash of difficulties
let difficultiesHash = '';

// Function to calculate hash of difficulties
async function calculateDifficultiesHash(): Promise<string> {
  try {
    const diffs = await Difficulty.findAll();
    const diffsList = diffs.map(diff => diff.toJSON());
    
    // Create a string representation of the difficulties
    const diffsString = JSON.stringify(diffsList);
    
    // Calculate hash
    const hash = crypto.createHash('sha256').update(diffsString).digest('hex');
    return hash;
  } catch (error) {
    logger.error('Error calculating difficulties hash:', error);
    return '';
  }
}

// Initialize the hash
(async () => {
  difficultiesHash = await calculateDifficultiesHash();
})();

// Fix __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Cache directory path
const ICON_CACHE_DIR = path.join(__dirname, '../../../cache/icons');
const ICON_IMAGE_API = process.env.ICON_IMAGE_API || '/api/images';
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
    const newUrl = `${ownUrlEnv}${ICON_IMAGE_API}/icon/${fileName}`;

    // Always attempt to cache the icon, even if it's already a cached URL
    try {
      const response = await axios.get(iconUrl, {responseType: 'arraybuffer'});
      await fs.writeFile(filePath, Buffer.from(response.data));
    } catch (error) {
      logger.error(`Failed to cache icon for ${diffName}:`, error);
      // If caching fails but file exists, continue using existing cache
      if (!(await fs.stat(filePath).catch(() => false))) {
        throw error; // Re-throw if no cached file exists
      }
    }

    return newUrl;
  } catch (error) {
    logger.error(`Failed to process icon for ${diffName}:`, error);
    return iconUrl; // Return original URL as fallback
  }
}

// Add this function before the router definition
function validateCustomDirective(condition: DirectiveCondition): { isValid: boolean; error?: string } {
  if (condition.type !== 'CUSTOM' || !condition.customFunction) {
    return { isValid: true };
  }

  try {
    // Try to parse the custom function
    const parser = new DirectiveParser(condition.customFunction);
    parser.parse();
    return { isValid: true };
  } catch (error) {
    return { 
      isValid: false, 
      error: error instanceof Error ? error.message : 'Invalid custom directive format'
    };
  }
}

const router: Router = express.Router();

// Get the current hash of difficulties
router.get('/hash', async (req, res) => {
  try {
    res.json({ hash: difficultiesHash });
  } catch (error) {
    logger.error('Error fetching difficulties hash:', error);
    res.status(500).json({error: 'Internal server error'});
  }
});

// Get available channels
router.get('/channels', Auth.superAdminPassword(), async (req, res) => {
  try {
    const channels = await AnnouncementChannel.findAll({
      where: { isActive: true },
      order: [['label', 'ASC']],
    });
    res.json(channels);
  } catch (error) {
    logger.error('Error fetching channels:', error);
    res.status(500).json({ error: 'Failed to fetch channels' });
  }
});

// Create a new channel
router.post('/channels', Auth.superAdminPassword(), async (req, res) => {
  try {
    const { webhookUrl, label } = req.body;

    if (!webhookUrl || !label) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const channel = await AnnouncementChannel.create({
      webhookUrl,
      label,
      isActive: true,
    });

    return res.status(201).json({ message: 'Channel created successfully', channel });
  } catch (error) {
    logger.error('Error creating channel:', error);
    return res.status(500).json({ error: 'Failed to create channel' });
  }
});

// Update a channel
router.put('/channels/:id([0-9]+)', Auth.superAdminPassword(), async (req, res) => {
  try {
    const channelId = req.params.id;
    const { webhookUrl, label } = req.body;

    if (!webhookUrl || !label) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const channel = await AnnouncementChannel.findOne({
      where: {
        id: channelId,
        isActive: true,
      },
    });

    if (!channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    await channel.update({
      webhookUrl,
      label,
    });

    return res.json({ message: 'Channel updated successfully', channel });
  } catch (error) {
    logger.error('Error updating channel:', error);
    return res.status(500).json({ error: 'Failed to update channel' });
  }
});

// Delete a channel
router.delete('/channels/:id([0-9]+)', Auth.superAdminPassword(), async (req, res) => {
  try {
    const channelId = req.params.id;

    const channel = await AnnouncementChannel.findOne({
      where: {
        id: channelId,
        isActive: true,
      },
    });

    if (!channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // Soft delete by setting isActive to false
    await channel.update({ isActive: false });

    return res.json({ message: 'Channel deleted successfully' });
  } catch (error) {
    logger.error('Error deleting channel:', error);
    return res.status(500).json({ error: 'Failed to delete channel' });
  }
});

// Get available roles
router.get('/roles', Auth.superAdminPassword(), async (req, res) => {
  try {
    const roles = await AnnouncementRole.findAll({
      where: { isActive: true },
      order: [['label', 'ASC']],
    });
    res.json(roles);
  } catch (error) {
    logger.error('Error fetching roles:', error);
    res.status(500).json({ error: 'Failed to fetch roles' });
  }
});

// Create a new role
router.post('/roles', Auth.superAdminPassword(), async (req, res) => {
  try {
    const { roleId, label } = req.body;

    if (!roleId || !label) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const role = await AnnouncementRole.create({
      roleId,
      label,
      isActive: true,
    });

    return res.status(201).json({ message: 'Role created successfully', role });
  } catch (error) {
    logger.error('Error creating role:', error);
    return res.status(500).json({ error: 'Failed to create role' });
  }
});

// Update a role
router.put('/roles/:id([0-9]+)', Auth.superAdminPassword(), async (req, res) => {
  try {
    const roleId = req.params.id;
    const { roleId: newRoleId, label } = req.body;

    if (!newRoleId || !label) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const role = await AnnouncementRole.findOne({
      where: {
        id: roleId,
        isActive: true,
      },
    });

    if (!role) {
      return res.status(404).json({ error: 'Role not found' });
    }

    await role.update({
      roleId: newRoleId,
      label,
    });

    return res.json({ message: 'Role updated successfully', role });
  } catch (error) {
    logger.error('Error updating role:', error);
    return res.status(500).json({ error: 'Failed to update role' });
  }
});

// Delete a role
router.delete('/roles/:id([0-9]+)', Auth.superAdminPassword(), async (req, res) => {
  try {
    const roleId = req.params.id;

    const role = await AnnouncementRole.findOne({
      where: {
        id: roleId,
        isActive: true,
      },
    });

    if (!role) {
      return res.status(404).json({ error: 'Role not found' });
    }

    // Soft delete by setting isActive to false
    await role.update({ isActive: false });

    return res.json({ message: 'Role deleted successfully' });
  } catch (error) {
    logger.error('Error deleting role:', error);
    return res.status(500).json({ error: 'Failed to delete role' });
  }
});

// Get all difficulties
router.get('/', async (req, res) => {
  try {
    const diffs = await Difficulty.findAll();
    const diffsList = diffs.map(diff => diff.toJSON());
    res.json(diffsList);
  } catch (error) {
    logger.error('Error fetching difficulties:', error);
    res.status(500).json({error: 'Internal server error'});
  }
});

// Create new difficulty
router.post('/', Auth.superAdminPassword(), async (req: Request, res: Response) => {
    try {
      const {
        id,
        name,
        type,
        icon,
        emoji,
        color,
        baseScore,
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
      const lastSortOrder = await Difficulty.max('sortOrder') as number;

      const difficulty = await Difficulty.create({
        id,
        name,
        type,
        icon: cachedIcon,
        emoji,
        color,
        baseScore,
        legacy,
        legacyIcon: cachedLegacyIcon,
        legacyEmoji,
        sortOrder: lastSortOrder + 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as IDifficulty);

      // Update the hash after creating a new difficulty
      difficultiesHash = await calculateDifficultiesHash();

      return res.status(201).json(difficulty);
    } catch (error) {
      logger.error('Error creating difficulty:', error);
      return res.status(500).json({error: 'Failed to create difficulty'});
    }
  },
);

// Update difficulty
router.put('/:id([0-9]+)', Auth.superAdminPassword(), async (req: Request, res: Response) => {
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
        await safeTransactionRollback(transaction);
        return res.status(404).json({error: 'Difficulty not found'});
      }

      // Check for name duplication if name is being changed
      if (name && name !== difficulty.name) {
        const existingDiffName = await Difficulty.findOne({where: {name}});
        if (existingDiffName) {
          await safeTransactionRollback(transaction);
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
          logger.error('Error reloading stats:', error);
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

      // Update the hash after updating a difficulty
      difficultiesHash = await calculateDifficultiesHash();

      return res.json(difficulty);
    } catch (error) {
      await safeTransactionRollback(transaction);
      logger.error('Error updating difficulty:', error);
      return res.status(500).json({error: 'Failed to update difficulty'});
    }
  },
);

// Delete difficulty with fallback
router.delete('/:id([0-9]+)', Auth.superAdminPassword(), async (req: Request, res: Response) => {
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
      const transaction = await sequelize.transaction();

      try {
        // First, update all levels that use this difficulty to use the fallback
        const affectedLevels = await Level.findAll({
          where: { diffId: diffId },
          transaction,
        });
        await Level.update(
          {diffId: fallbackDiffId},
          {
            where: {diffId: diffId},
            transaction,
            individualHooks: true,
          },
        );

        // Add rerate history for all affected levels
        for (const level of affectedLevels) {
          await LevelRerateHistory.create({
            levelId: level.id,
            previousDiffId: diffId,
            newDiffId: fallbackDiffId,
            previousBaseScore: level.baseScore || difficulty.baseScore,
            newBaseScore: level.baseScore || fallbackDifficulty.baseScore,
            reratedBy: req.user?.id || null,
            createdAt: new Date(),
          }, { transaction });
        }

        // Instead of deleting, mark the difficulty as LEGACY
        await difficulty.update({ type: 'LEGACY' as any }, { transaction });

        // Commit transaction
        await transaction.commit();

        // Update the hash after deleting a difficulty
        difficultiesHash = await calculateDifficultiesHash();

        return res.json({
          message: 'Difficulty marked as LEGACY',
          updatedLevels: await Level.count({where: {diffId: fallbackDiffId}}),
        });
      } catch (error) {
        // Rollback transaction on error
        logger.error('Error deleting difficulty:', error);
        await safeTransactionRollback(transaction);
        throw error;
      }
    } catch (error) {
      logger.error('Error deleting difficulty:', error);
      return res.status(500).json({error: 'Failed to delete difficulty'});
    }
  },
);

interface DirectiveInput {
  name: string;
  description: string;
  mode: 'STATIC' | 'CONDITIONAL';
  triggerType: 'PASS' | 'LEVEL';
  condition?: {
    type: 'ACCURACY' | 'WORLDS_FIRST' | 'BASE_SCORE' | 'CUSTOM';
    value?: number;
    operator?: 'EQUAL' | 'GREATER_THAN' | 'LESS_THAN' | 'GREATER_THAN_EQUAL' | 'LESS_THAN_EQUAL';
    customFunction?: string;
  };
  actions: {
    channelId: number;
    pingType: 'NONE' | 'ROLE' | 'EVERYONE';
    roleId?: number;
  }[];
  isActive: boolean;
  firstOfKind: boolean;
}

// Get announcement directives for a difficulty
router.get('/:id([0-9]+)/directives', Auth.superAdminPassword(), async (req: Request, res: Response) => {
  try {
    const diffId = parseInt(req.params.id);

    // Validate difficulty exists
    const difficulty = await Difficulty.findByPk(diffId);
    if (!difficulty) {
      return res.status(404).json({ error: 'Difficulty not found' });
    }

    // Get all active directives for this difficulty with related data
    const directives = await AnnouncementDirective.findAll({
      where: {
        difficultyId: diffId,
        isActive: true,
      },
      include: [{
        model: DirectiveAction,
        as: 'actions',
        include: [
          {
            model: AnnouncementChannel,
            as: 'channel',
            attributes: ['id', 'label', 'webhookUrl']
          },
          {
            model: AnnouncementRole,
            as: 'role',
            attributes: ['id', 'roleId', 'label']
          }
        ]
      }]
    });

    return res.json(directives);
  } catch (error) {
    logger.error('Error fetching announcement directives:', error);
    return res.status(500).json({ error: 'Failed to fetch announcement directives' });
  }
});

// Configure announcement directives for a difficulty
router.post('/:id([0-9]+)/directives', Auth.superAdminPassword(), async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const id = parseInt(req.params.id);
    const directives: DirectiveInput[] = req.body.directives;

    // Validate difficulty exists
    const difficulty = await Difficulty.findByPk(id);
    if (!difficulty) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({ error: 'Difficulty not found' });
    }

    // Validate each directive
    for (const directive of directives) {
      if (!directive.name || !directive.actions || !directive.mode || !directive.triggerType) {
        await safeTransactionRollback(transaction);
        return res.status(400).json({ error: 'Invalid directive format' });
      }

      // Validate mode
      if (!['STATIC', 'CONDITIONAL'].includes(directive.mode)) {
        await safeTransactionRollback(transaction);
        return res.status(400).json({ error: 'Invalid directive mode' });
      }

      // Validate trigger type
      if (!['PASS', 'LEVEL'].includes(directive.triggerType)) {
        await safeTransactionRollback(transaction);
        return res.status(400).json({ error: 'Invalid trigger type' });
      }

      // Validate condition for conditional mode
      if (directive.mode === 'CONDITIONAL') {
        if (!directive.condition) {
          await safeTransactionRollback(transaction);
          return res.status(400).json({ error: 'Condition required for conditional mode' });
        }

        if (!['ACCURACY', 'WORLDS_FIRST', 'BASE_SCORE', 'CUSTOM'].includes(directive.condition.type)) {
          await safeTransactionRollback(transaction);
          return res.status(400).json({ error: 'Invalid condition type' });
        }

        // Validate condition parameters based on type
        switch (directive.condition.type) {
          case 'ACCURACY':
          case 'BASE_SCORE':
            if (directive.condition.value === undefined || !directive.condition.operator) {
              await safeTransactionRollback(transaction);
              return res.status(400).json({ error: 'Missing condition parameters' });
            }
            if (!['EQUAL', 'GREATER_THAN', 'LESS_THAN', 'GREATER_THAN_EQUAL', 'LESS_THAN_EQUAL'].includes(directive.condition.operator)) {
              await safeTransactionRollback(transaction);
              return res.status(400).json({ error: 'Invalid operator' });
            }
            break;
          case 'CUSTOM':
            if (!directive.condition.customFunction) {
              await safeTransactionRollback(transaction);
              return res.status(400).json({ error: 'Missing custom function' });
            }
            // Validate custom function format
            const validation = validateCustomDirective(directive.condition);
            if (!validation.isValid) {
              await safeTransactionRollback(transaction);
              return res.status(400).json({ 
                error: 'Invalid custom directive format',
                details: validation.error
              });
            }
            break;
        }
      }

      // Validate actions
      for (const action of directive.actions) {
        if (!action.channelId || !['NONE', 'ROLE', 'EVERYONE'].includes(action.pingType)) {
          await safeTransactionRollback(transaction);
          return res.status(400).json({ error: 'Invalid action format' });
        }
        if (action.pingType === 'ROLE' && !action.roleId) {
          await safeTransactionRollback(transaction);
          return res.status(400).json({ error: 'Role ID required for role pings' });
        }
      }
    }

    // Delete existing directives and their actions
    await AnnouncementDirective.destroy({ 
      where: { difficultyId: id },
      transaction 
    });

    // Create new directives with their actions
    const createdDirectives = await Promise.all(
      directives.map(async (directive, index) => {
        const createdDirective = await AnnouncementDirective.create({
          difficultyId: id,
          name: directive.name,
          description: directive.description,
          mode: directive.mode,
          triggerType: directive.triggerType,
          condition: directive.condition as DirectiveCondition,
          isActive: directive.isActive,
          firstOfKind: directive.firstOfKind,
          createdAt: new Date(),
          updatedAt: new Date(),
        }, { transaction });

        // Create actions for this directive
        await Promise.all(
          directive.actions.map(action =>
            DirectiveAction.create({
              directiveId: createdDirective.id,
              channelId: action.channelId,
              pingType: action.pingType,
              roleId: action.roleId,
              isActive: true,
              createdAt: new Date(),
              updatedAt: new Date(),
            }, { transaction })
          )
        );

        return createdDirective;
      })
    );

    await transaction.commit();

    // Fetch the created directives with their related data
    const fullDirectives = await AnnouncementDirective.findAll({
      where: { 
        id: createdDirectives.map(d => d.id) 
      },
      include: [{
        model: DirectiveAction,
        as: 'actions',
        include: [
          {
            model: AnnouncementChannel,
            as: 'channel',
            attributes: ['id', 'label', 'webhookUrl']
          },
          {
            model: AnnouncementRole,
            as: 'role',
            attributes: ['id', 'roleId', 'label']
          }
        ]
      }]
    });

    return res.json(fullDirectives);
  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error creating directives:', error);
    return res.status(500).json({ error: 'Failed to create directives' });
  }
});

// Verify super admin password
router.head('/verify-password', Auth.superAdminPassword(), async (req, res) => {
    return res.status(200).send();
});

// Update difficulty sort orders in bulk
router.put('/sort-orders', Auth.superAdminPassword(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  try {
    const { sortOrders } = req.body;
    
    if (!Array.isArray(sortOrders)) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'Invalid sort orders format' });
    }

    // Update each difficulty's sort order
    await Promise.all(
      sortOrders.map(async (item) => {
        const { id, sortOrder } = item;
        if (id === undefined || sortOrder === undefined) {
          throw new Error('Missing id or sortOrder in sort orders array');
        }
        
        const difficulty = await Difficulty.findByPk(id);
        if (!difficulty) {
          throw new Error(`Difficulty with ID ${id} not found`);
        }
        
        await difficulty.update({ sortOrder }, { transaction });
      })
    );

    await transaction.commit();
    
    // Update the hash after updating sort orders
    difficultiesHash = await calculateDifficultiesHash();
    
    // Emit events for frontend updates
    const io = getIO();
    io.emit('difficultiesReordered');
    
    sseManager.broadcast({
      type: 'difficultiesReordered',
      data: {
        action: 'reorder',
        count: sortOrders.length
      }
    });
    
    return res.json({ message: 'Sort orders updated successfully' });
  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error updating sort orders:', error);
    return res.status(500).json({ 
      error: 'Failed to update sort orders',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

export default router;
