import express, {Router, Request, Response} from 'express';
import Difficulty from '../../../models/levels/Difficulty.js';
import Level from '../../../models/levels/Level.js';
import Pass from '../../../models/passes/Pass.js';
import Judgement from '../../../models/passes/Judgement.js';
import {Auth} from '../../middleware/auth.js';
import {Op} from 'sequelize';
import {ConditionOperator, DirectiveCondition, DirectiveConditionType, IDifficulty} from '../../interfaces/models/index.js';
import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import {getIO} from '../../../misc/utils/server/socket.js';
import {sseManager} from '../../../misc/utils/server/sse.js';
import {getScoreV2} from '../../../misc/utils/pass/CalcScore.js';
import {PlayerStatsService} from '../../services/PlayerStatsService.js';
import sequelize from '../../../config/db.js';
import AnnouncementDirective from '../../../models/announcements/AnnouncementDirective.js';
import AnnouncementChannel from '../../../models/announcements/AnnouncementChannel.js';
import AnnouncementRole from '../../../models/announcements/AnnouncementRole.js';
import DirectiveAction from '../../../models/announcements/DirectiveAction.js';
import { DirectiveParser } from '../../../misc/utils/data/directiveParser.js';
import crypto from 'crypto';
import { logger } from '../../services/LoggerService.js';
import LevelRerateHistory from '../../../models/levels/LevelRerateHistory.js';
import { safeTransactionRollback, getFileIdFromCdnUrl, isCdnUrl } from '../../../misc/utils/Utility.js';
import CurationType from '../../../models/curations/CurationType.js';
import LevelTag from '../../../models/levels/LevelTag.js';
import LevelTagAssignment from '../../../models/levels/LevelTagAssignment.js';
import cdnService, { CdnError } from '../../services/CdnService.js';
import multer from 'multer';

const playerStatsService = PlayerStatsService.getInstance();

// Configure multer for tag icon uploads (memory storage)
const tagIconUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit (matching TAG_ICON config)
  },
  fileFilter: (req, file, cb) => {
    // Allow image files
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  },
});

// Configure multer for difficulty icon uploads (memory storage)
const difficultyIconUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    // Allow image files
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/svg+xml'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPEG, PNG, WebP, and SVG files are allowed.'));
    }
  },
});

// Store the current hash of difficulties
let difficultiesHash = '';

// Function to calculate hash of difficulties
async function calculateDifficultiesHash(): Promise<string> {
  try {
    const diffs = await Difficulty.findAll();
    const diffsList = diffs.map(diff => diff.toJSON());
    const curationTypes = await CurationType.findAll();
    const curationTypesList = curationTypes.map(type => type.toJSON());
    const tags = await LevelTag.findAll();
    const tagsList = tags.map(tag => tag.toJSON());

    // Create a string representation of the difficulties
    const diffsString = JSON.stringify(diffsList);
    const curationTypesString = JSON.stringify(curationTypesList);
    const tagsString = JSON.stringify(tagsList);
    // Calculate hash
    const hash = crypto.createHash('sha256').update(diffsString).digest('hex');
    const curationTypesHash = crypto.createHash('sha256').update(curationTypesString).digest('hex');
    const tagsHash = crypto.createHash('sha256').update(tagsString).digest('hex');
    return `${hash}-${curationTypesHash}-${tagsHash}` + (process.env.NODE_ENV==='development' ? `-${Date.now()}` : '');
  } catch (error) {
    logger.error('Error calculating difficulties hash:', error);
    return '';
  }
}

async function updateDifficultiesHash() {
  difficultiesHash = await calculateDifficultiesHash();
}
// Initialize the hash
await updateDifficultiesHash();

// Cache directory path
const CACHE_PATH = process.env.CACHE_PATH || path.join(process.cwd(), 'cache');
const ICON_CACHE_DIR = path.join(CACHE_PATH, 'icons');
const ICON_IMAGE_API = process.env.ICON_IMAGE_API || '/api/images';
const ownUrlEnv =
  process.env.NODE_ENV === 'production'
    ? process.env.PROD_API_URL
    : process.env.NODE_ENV === 'staging'
      ? process.env.STAGING_API_URL
      : process.env.NODE_ENV === 'development'
        ? process.env.DEV_URL
        : 'http://localhost:3002';

// Helper function to download and cache icons from URL (legacy support)
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

// Helper function to save uploaded icon file to local cache
async function saveIconToCache(iconBuffer: Buffer, diffName: string, originalFilename: string, isLegacy = false): Promise<string> {
  try {
    await fs.mkdir(ICON_CACHE_DIR, {recursive: true});

    // Get file extension from original filename or default to png
    const ext = path.extname(originalFilename).toLowerCase() || '.png';
    const prefix = isLegacy ? 'legacy_' : '';
    const fileName = `${prefix}${diffName.replace(/[^a-zA-Z0-9]/g, '_')}${ext}`;
    const filePath = path.join(ICON_CACHE_DIR, fileName);
    const newUrl = `${ownUrlEnv}${ICON_IMAGE_API}/icon/${fileName}`;

    await fs.writeFile(filePath, iconBuffer);

    return newUrl;
  } catch (error) {
    logger.error(`Failed to save icon to cache for ${diffName}:`, error);
    throw error;
  }
}

// Add this function before the router definition
function validateCustomDirective(condition: DirectiveCondition): { isValid: boolean; error?: string } {
  if (condition.type !== DirectiveConditionType.CUSTOM || !condition.customFunction) {
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
router.put('/channels/:id([0-9]{1,20})', Auth.superAdminPassword(), async (req, res) => {
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
router.delete('/channels/:id([0-9]{1,20})', Auth.superAdminPassword(), async (req, res) => {
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
    const { roleId, label, messageFormat } = req.body;

    if (!roleId || !label) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Validate messageFormat if provided
    if (messageFormat) {
      if (messageFormat.length > 500) {
        return res.status(400).json({ error: 'Message format cannot exceed 500 characters' });
      }
      // Validate format contains at least one valid variable
      const validVariables = ['{count}', '{difficultyName}', '{ping}', '{groupName}'];
      const hasRequiredVariable = validVariables.some(v => messageFormat.includes(v));
      if (!hasRequiredVariable) {
        return res.status(400).json({
          error: `Message format must contain at least one of: ${validVariables.join(', ')}`
        });
      }
    }

    const role = await AnnouncementRole.create({
      roleId,
      label,
      messageFormat: messageFormat || null,
      isActive: true,
    });

    return res.status(201).json({ message: 'Role created successfully', role });
  } catch (error) {
    logger.error('Error creating role:', error);
    return res.status(500).json({ error: 'Failed to create role' });
  }
});

// Update a role
router.put('/roles/:id([0-9]{1,20})', Auth.superAdminPassword(), async (req, res) => {
  try {
    const roleId = req.params.id;
    const { roleId: newRoleId, label, messageFormat } = req.body;

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

    // Validate messageFormat if provided
    if (messageFormat !== undefined) {
      if (messageFormat && messageFormat.length > 500) {
        return res.status(400).json({ error: 'Message format cannot exceed 500 characters' });
      }
      if (messageFormat) {
        // Validate format contains at least one valid variable
        const validVariables = ['{count}', '{difficultyName}', '{ping}', '{groupName}'];
        const hasRequiredVariable = validVariables.some(v => messageFormat.includes(v));
        if (!hasRequiredVariable) {
          return res.status(400).json({
            error: `Message format must contain at least one of: ${validVariables.join(', ')}`
          });
        }
      }
    }

    await role.update({
      roleId: newRoleId,
      label,
      messageFormat: messageFormat !== undefined ? (messageFormat || null) : role.messageFormat,
    });

    return res.json({ message: 'Role updated successfully', role });
  } catch (error) {
    logger.error('Error updating role:', error);
    return res.status(500).json({ error: 'Failed to update role' });
  }
});

// Delete a role
router.delete('/roles/:id([0-9]{1,20})', Auth.superAdminPassword(), async (req, res) => {
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

// Upload difficulty icon
router.post('/:id([0-9]{1,20})/icon', Auth.superAdminPassword(), difficultyIconUpload.single('icon'), async (req: Request, res: Response) => {
  try {
    const diffId = parseInt(req.params.id);

    if (!req.file) {
      return res.status(400).json({error: 'No icon file uploaded'});
    }

    const difficulty = await Difficulty.findByPk(diffId);
    if (!difficulty) {
      return res.status(404).json({error: 'Difficulty not found'});
    }

    // Save to local cache
    const cachedIconUrl = await saveIconToCache(
      req.file.buffer,
      difficulty.name,
      req.file.originalname,
      false
    );

    // Update difficulty with cached icon URL
    await difficulty.update({
      icon: cachedIconUrl
    });

    await updateDifficultiesHash();

    return res.json({
      success: true,
      icon: difficulty.icon
    });
  } catch (error) {
    logger.error('Error uploading difficulty icon:', error);
    return res.status(500).json({error: 'Failed to upload icon'});
  }
});

// Upload difficulty legacy icon
router.post('/:id([0-9]{1,20})/legacy-icon', Auth.superAdminPassword(), difficultyIconUpload.single('icon'), async (req: Request, res: Response) => {
  try {
    const diffId = parseInt(req.params.id);

    if (!req.file) {
      return res.status(400).json({error: 'No icon file uploaded'});
    }

    const difficulty = await Difficulty.findByPk(diffId);
    if (!difficulty) {
      return res.status(404).json({error: 'Difficulty not found'});
    }

    // Save to local cache
    const cachedIconUrl = await saveIconToCache(
      req.file.buffer,
      difficulty.name,
      req.file.originalname,
      true
    );

    // Update difficulty with cached legacy icon URL
    await difficulty.update({
      legacyIcon: cachedIconUrl
    });

    await updateDifficultiesHash();

    return res.json({
      success: true,
      legacyIcon: difficulty.legacyIcon
    });
  } catch (error) {
    logger.error('Error uploading difficulty legacy icon:', error);
    return res.status(500).json({error: 'Failed to upload legacy icon'});
  }
});

// Helper function to find the smallest unoccupied ID
async function findSmallestUnoccupiedId(): Promise<number> {
  const allDifficulties = await Difficulty.findAll({
    attributes: ['id'],
    order: [['id', 'ASC']]
  });

  const existingIds = new Set(allDifficulties.map(d => d.id));

  // Start from 1 and find the first gap
  let candidateId = 1;
  while (existingIds.has(candidateId)) {
    candidateId++;
  }

  return candidateId;
}

// Create new difficulty
router.post('/', Auth.superAdminPassword(), difficultyIconUpload.fields([
  { name: 'icon', maxCount: 1 },
  { name: 'legacyIcon', maxCount: 1 }
]), async (req: Request, res: Response) => {
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

      // Determine the ID to use - only if explicitly provided
      let difficultyId: number;
      if (id !== undefined && id !== null && id !== '') {
        // ID provided - check for duplicate
        const existingDiffId = await Difficulty.findByPk(parseInt(id));
        if (existingDiffId) {
          return res
            .status(400)
            .json({error: 'A difficulty with this ID already exists'});
        }
        difficultyId = parseInt(id);
      } else {
        // ID not provided - find smallest unoccupied ID at database level
        difficultyId = await findSmallestUnoccupiedId();
      }

      // Check for duplicate name
      const existingDiffName = await Difficulty.findOne({where: {name}});
      if (existingDiffName) {
        return res
          .status(400)
          .json({error: 'A difficulty with this name already exists'});
      }

      // Handle icon uploads: Priority 1 - file attached -> save to cache
      // Priority 2 - URL provided -> cache from URL
      // Otherwise - null
      let finalIcon: string | null = null;
      const iconFile = (req.files as { [fieldname: string]: Express.Multer.File[] })?.['icon']?.[0];
      const legacyIconFile = (req.files as { [fieldname: string]: Express.Multer.File[] })?.['legacyIcon']?.[0];

      if (iconFile) {
        // Priority 1: File uploaded
        finalIcon = await saveIconToCache(iconFile.buffer, name, iconFile.originalname, false);
      } else if (icon && typeof icon === 'string') {
        if (icon.startsWith('http://') || icon.startsWith('https://')) {
          // Priority 2: URL provided - cache it
          finalIcon = await cacheIcon(icon, name);
        } else if (icon === 'null' || icon === null) {
          // Explicitly null
          finalIcon = null;
        } else {
          // Assume it's already a cached URL
          finalIcon = icon;
        }
      }

      let finalLegacyIcon: string | null = null;
      if (legacyIconFile) {
        // Priority 1: File uploaded
        finalLegacyIcon = await saveIconToCache(legacyIconFile.buffer, name, legacyIconFile.originalname, true);
      } else if (legacyIcon && typeof legacyIcon === 'string') {
        if (legacyIcon.startsWith('http://') || legacyIcon.startsWith('https://')) {
          // Priority 2: URL provided - cache it
          finalLegacyIcon = await cacheIcon(legacyIcon, `legacy_${name}`);
        } else if (legacyIcon === 'null' || legacyIcon === null) {
          // Explicitly null
          finalLegacyIcon = null;
        } else {
          // Assume it's already a cached URL
          finalLegacyIcon = legacyIcon;
        }
      }

      const lastSortOrder = await Difficulty.max('sortOrder') as number;

      const difficulty = await Difficulty.create({
        id: difficultyId,
        name,
        type,
        icon: finalIcon,
        emoji,
        color,
        baseScore,
        legacy,
        legacyIcon: finalLegacyIcon,
        legacyEmoji,
        sortOrder: lastSortOrder + 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as IDifficulty);

      // Update the hash after creating a new difficulty
      await updateDifficultiesHash();

      return res.status(201).json(difficulty);
    } catch (error) {
      logger.error('Error creating difficulty:', error);
      return res.status(500).json({error: 'Failed to create difficulty'});
    }
  },
);

// Update difficulty
router.put('/:id([0-9]{1,20})', Auth.superAdminPassword(), difficultyIconUpload.fields([
  { name: 'icon', maxCount: 1 },
  { name: 'legacyIcon', maxCount: 1 }
]), async (req: Request, res: Response) => {
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

      // Handle icon updates with priority logic (similar to tags):
      // Priority 1: file attached -> update icon
      // Priority 2: null explicitly passed -> remove icon
      // Priority 3: URL provided -> cache from URL
      // Otherwise: no change
      const iconFile = (req.files as { [fieldname: string]: Express.Multer.File[] })?.['icon']?.[0];
      const legacyIconFile = (req.files as { [fieldname: string]: Express.Multer.File[] })?.['legacyIcon']?.[0];

      let finalIcon: string | null | undefined = undefined;
      if (iconFile) {
        // Priority 1: File attached -> update icon
        finalIcon = await saveIconToCache(iconFile.buffer, name || difficulty.name, iconFile.originalname, false);
      } else if (icon === 'null' || icon === null) {
        // Priority 2: null explicitly passed -> remove icon
        finalIcon = null;
      } else if (icon && icon !== difficulty.icon) {
        // Priority 3: URL or existing URL provided
        if (typeof icon === 'string' && (icon.startsWith('http://') || icon.startsWith('https://'))) {
          finalIcon = await cacheIcon(icon, name || difficulty.name);
        } else {
          // Assume it's already a cached URL
          finalIcon = icon;
        }
      }
      // Otherwise: finalIcon remains undefined, which means no change

      let finalLegacyIcon: string | null | undefined = undefined;
      if (legacyIconFile) {
        // Priority 1: File attached -> update legacy icon
        finalLegacyIcon = await saveIconToCache(legacyIconFile.buffer, name || difficulty.name, legacyIconFile.originalname, true);
      } else if (legacyIcon === 'null' || legacyIcon === null) {
        // Priority 2: null explicitly passed -> remove legacy icon
        finalLegacyIcon = null;
      } else if (legacyIcon && legacyIcon !== difficulty.legacyIcon) {
        // Priority 3: URL or existing URL provided
        if (typeof legacyIcon === 'string' && (legacyIcon.startsWith('http://') || legacyIcon.startsWith('https://'))) {
          finalLegacyIcon = await cacheIcon(legacyIcon, `legacy_${name || difficulty.name}`);
        } else {
          // Assume it's already a cached URL
          finalLegacyIcon = legacyIcon;
        }
      }
      // Otherwise: finalLegacyIcon remains undefined, which means no change

      // Check if base score is being changed
      const isBaseScoreChanged =
        baseScore !== undefined && baseScore !== difficulty.baseScore;

      // Update the difficulty with nullish coalescing
      // Only update icon fields if they were explicitly changed
      const updateData: Partial<IDifficulty> = {
        name: name ?? difficulty.name,
        type: type ?? difficulty.type,
        emoji: emoji ?? difficulty.emoji,
        color: color ?? difficulty.color,
        baseScore: baseScore ?? difficulty.baseScore,
        sortOrder: sortOrder ?? difficulty.sortOrder,
        legacy: legacy ?? difficulty.legacy,
        legacyEmoji: legacyEmoji ?? difficulty.legacyEmoji,
        updatedAt: new Date(),
      };

      if (finalIcon !== undefined) {
        updateData.icon = finalIcon as any;
      }
      if (finalLegacyIcon !== undefined) {
        updateData.legacyIcon = finalLegacyIcon as any;
      }

      await difficulty.update(updateData, {transaction});

      // If base score changed, recalculate scores for all affected passes
      let affectedPassCount = 0;
      const affectedPlayerIds: Set<number> = new Set();

      if (isBaseScoreChanged) {
        // Only get levels that rely on the difficulty's baseScore as fallback
        // (levels with their own baseScore won't be affected by this change)
        const levels = await Level.findAll({
          attributes: ['id', 'baseScore', 'ppBaseScore'],
          where: {
            diffId: diffId,
            [Op.or]: [
              {baseScore: null},
              {baseScore: 0},
            ],
          },
          transaction,
        });

        const levelIds = levels.map(level => level.id);

        if (levelIds.length > 0) {
          // Build a lookup map for level data to avoid re-querying
          const levelDataMap = new Map(
            levels.map(level => [level.id, {
              baseScore: level.baseScore,
              ppBaseScore: level.ppBaseScore,
            }])
          );

          // Use the known updated difficulty values directly (no need to re-fetch)
          const updatedDifficulty = {
            name: updateData.name as string,
            baseScore: updateData.baseScore as number,
          };

          // Get all non-deleted passes for affected levels with limited columns
          const affectedPasses = await Pass.findAll({
            attributes: ['id', 'speed', 'isNoHoldTap', 'playerId', 'levelId', 'scoreV2'],
            where: {
              levelId: {[Op.in]: levelIds},
              isDeleted: false,
            },
            include: [
              {
                model: Judgement,
                as: 'judgements',
              },
            ],
            transaction,
          });

          // Calculate all new scores first
          const scoreUpdates: {id: number; scoreV2: number}[] = [];

          for (const pass of affectedPasses) {
            if (!pass.judgements) continue;

            const level = levelDataMap.get(pass.levelId);
            if (!level) continue;

            const levelData = {
              baseScore: level.baseScore,
              ppBaseScore: level.ppBaseScore,
              difficulty: updatedDifficulty,
            };

            const passData = {
              speed: pass.speed || 1.0,
              judgements: pass.judgements,
              isNoHoldTap: pass.isNoHoldTap || false,
            };

            const newScore = getScoreV2(passData, levelData);
            scoreUpdates.push({id: pass.id, scoreV2: newScore});

            if (pass.playerId) {
              affectedPlayerIds.add(pass.playerId);
            }
          }

          // Batch update pass scores using CASE WHEN (single query per batch)
          const BATCH_SIZE = 500;
          for (let i = 0; i < scoreUpdates.length; i += BATCH_SIZE) {
            const batch = scoreUpdates.slice(i, i + BATCH_SIZE);
            const ids = batch.map(u => u.id);
            const cases = batch.map(u => `WHEN ${u.id} THEN ${u.scoreV2}`).join(' ');

            await sequelize.query(
              `UPDATE passes SET scoreV2 = CASE id ${cases} END WHERE id IN (${ids.join(',')})`,
              {transaction},
            );
          }

          affectedPassCount = scoreUpdates.length;
        }
      }

      // Commit the transaction first to ensure all updates are saved
      await transaction.commit();

      // If base score was changed, update stats for affected players only
      if (isBaseScoreChanged && affectedPlayerIds.size > 0) {
        try {
          // Only recalculate stats for players whose passes were affected
          await playerStatsService.updatePlayerStats(Array.from(affectedPlayerIds));
          await playerStatsService.updateRanks();

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
              affectedPasses: affectedPassCount,
              affectedPlayers: affectedPlayerIds.size,
            },
          });
        } catch (error) {
          logger.error('Error updating player stats:', error);
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
      await updateDifficultiesHash();

      return res.json(difficulty);
    } catch (error) {
      await safeTransactionRollback(transaction);
      logger.error('Error updating difficulty:', error);
      return res.status(500).json({error: 'Failed to update difficulty'});
    }
  },
);

// Delete difficulty with fallback
router.delete('/:id([0-9]{1,20})', Auth.superAdminPassword(), async (req: Request, res: Response) => {
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
        await updateDifficultiesHash();

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
    type: DirectiveConditionType;
    value?: number;
    operator?: ConditionOperator;
    customFunction?: string;
  };
  actions: {
    channelId: number;
    pingType: 'NONE' | 'ROLE' | 'EVERYONE';
    roleId?: number;
  }[];
  isActive: boolean;
  firstOfKind: boolean;
  sortOrder?: number;
}

// Get announcement directives for a difficulty
router.get('/:id([0-9]{1,20})/directives', Auth.superAdminPassword(), async (req: Request, res: Response) => {
  try {
    const diffId = parseInt(req.params.id);

    // Validate difficulty exists
    const difficulty = await Difficulty.findByPk(diffId);
    if (!difficulty) {
      return res.status(404).json({ error: 'Difficulty not found' });
    }

    // Get all active directives for this difficulty with related data, ordered by sortOrder
    const directives = await AnnouncementDirective.findAll({
      where: {
        difficultyId: diffId,
        isActive: true,
      },
      order: [['sortOrder', 'ASC'], ['id', 'ASC']],
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
            attributes: ['id', 'roleId', 'label', 'messageFormat']
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
router.post('/:id([0-9]{1,20})/directives', Auth.superAdminPassword(), async (req, res) => {
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

        if (!DirectiveConditionType[directive.condition.type]) {
          await safeTransactionRollback(transaction);
          return res.status(400).json({ error: 'Invalid condition type' });
        }

        // Validate condition parameters based on type
        switch (directive.condition.type) {
          case DirectiveConditionType.ACCURACY:
          case DirectiveConditionType.BASE_SCORE:
            if (directive.condition.value === undefined || !directive.condition.operator) {
              await safeTransactionRollback(transaction);
              return res.status(400).json({ error: 'Missing condition parameters' });
            }
            if (!ConditionOperator[directive.condition.operator]) {
              await safeTransactionRollback(transaction);
              return res.status(400).json({ error: 'Invalid operator' });
            }
            break;
          case DirectiveConditionType.CUSTOM:
            if (!directive.condition.customFunction) {
              await safeTransactionRollback(transaction);
              return res.status(400).json({ error: 'Missing custom function' });
            }
            // Validate custom function format
            const validation = validateCustomDirective(directive.condition as DirectiveCondition);
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
          sortOrder: directive.sortOrder !== undefined ? directive.sortOrder : index,
          createdAt: new Date(),
          updatedAt: new Date(),
        }, { transaction });

        // Create actions for this directive
        await Promise.all(
          directive.actions.map(async (action) => {
            const createdAction = await DirectiveAction.create({
              directiveId: createdDirective.id,
              channelId: action.channelId,
              pingType: action.pingType,
              roleId: action.roleId,
              isActive: true,
              createdAt: new Date(),
              updatedAt: new Date(),
            }, { transaction });

            return createdAction;
          })
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
            attributes: ['id', 'roleId', 'label', 'messageFormat']
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
    return res.status(200).send({});
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
    await updateDifficultiesHash();

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

// ==================== TAG MANAGEMENT ENDPOINTS ====================

// Update tag sort orders in bulk
router.put('/tags/sort-orders', Auth.superAdminPassword(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  try {
    const { sortOrders } = req.body;

    if (!Array.isArray(sortOrders)) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'Invalid sort orders format' });
    }

    // Update each tag's sort order
    await Promise.all(
      sortOrders.map(async (item) => {
        const { id, sortOrder } = item;
        if (id === undefined || sortOrder === undefined) {
          throw new Error('Missing id or sortOrder in sort orders array');
        }

        const tag = await LevelTag.findByPk(id);
        if (!tag) {
          throw new Error(`Tag with ID ${id} not found`);
        }

        await tag.update({ sortOrder }, { transaction });
      })
    );

    await transaction.commit();

    // Update the hash after updating sort orders
    await updateDifficultiesHash();

    // Emit events for frontend updates
    const io = getIO();
    io.emit('tagsReordered');

    sseManager.broadcast({
      type: 'tagsReordered',
      data: {
        action: 'reorder',
        count: sortOrders.length
      }
    });

    return res.json({ message: 'Tag sort orders updated successfully' });
  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error updating tag sort orders:', error);
    return res.status(500).json({
      error: 'Failed to update tag sort orders',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

// Update group sort orders in bulk
router.put('/tags/group-sort-orders', Auth.superAdminPassword(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  try {
    const { groups } = req.body;

    if (!Array.isArray(groups)) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'Invalid groups format' });
    }

    // Update groupSortOrder for all tags in each group
    await Promise.all(
      groups.map(async (item) => {
        const { name, sortOrder } = item;
        if (name === undefined || sortOrder === undefined) {
          throw new Error('Missing name or sortOrder in groups array');
        }

        // Update all tags with matching group name
        // Use empty string check for "Ungrouped" which has null/empty group
        const whereClause = name === '' || name === null
          ? { [Op.or]: [{ group: null }, { group: '' }] }
          : { group: name };

        await LevelTag.update(
          { groupSortOrder: sortOrder },
          { where: whereClause, transaction }
        );
      })
    );

    await transaction.commit();

    // Update the hash after updating group sort orders
    await updateDifficultiesHash();

    // Emit events for frontend updates
    const io = getIO();
    io.emit('tagsReordered');

    sseManager.broadcast({
      type: 'tagsReordered',
      data: {
        action: 'groupReorder',
        count: groups.length
      }
    });

    return res.json({ message: 'Group sort orders updated successfully' });
  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error updating group sort orders:', error);
    return res.status(500).json({
      error: 'Failed to update group sort orders',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

// Get all tags
router.get('/tags', async (req: Request, res: Response) => {
  try {
    const tags = await LevelTag.findAll({
      order: [['groupSortOrder', 'ASC'], ['sortOrder', 'ASC'], ['name', 'ASC']],
    });
    res.json(tags);
  } catch (error) {
    logger.error('Error fetching tags:', error);
    res.status(500).json({ error: 'Failed to fetch tags' });
  }
});

// Create new tag
router.post('/tags', Auth.superAdminPassword(), tagIconUpload.single('icon'), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  try {
    const { name, color, icon, group } = req.body;
    const iconFile = req.file;

    if (!name || !color) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'Missing required fields: name and color are required' });
    }

    // Validate accent color format
    if (!/^#[0-9A-Fa-f]{6}$/.test(color)) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'Invalid color format. Must be a hex color (e.g., #FF5733)' });
    }

    // Check for duplicate name
    const existingTag = await LevelTag.findOne({ where: { name } });
    if (existingTag) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'A tag with this name already exists' });
    }

    // Handle icon upload: Priority 1 - file attached -> upload to CDN
    let finalIconUrl: string | null = null;
    if (iconFile) {
      try {
        const uploadResult = await cdnService.uploadTagIcon(
          iconFile.buffer,
          iconFile.originalname
        );
        finalIconUrl = uploadResult.urls.original;
      } catch (uploadError) {
        await safeTransactionRollback(transaction);

        // Handle CdnError with validation details
        if (uploadError instanceof CdnError) {
          const statusCode = uploadError.code === 'VALIDATION_ERROR' ? 400 : 500;
          const errorResponse: any = {
            error: uploadError.message,
            code: uploadError.code
          };

          // Include validation error details if available
          if (uploadError.details) {
            if (uploadError.details.errors) {
              errorResponse.errors = uploadError.details.errors;
            }
            if (uploadError.details.warnings) {
              errorResponse.warnings = uploadError.details.warnings;
            }
            if (uploadError.details.metadata) {
              errorResponse.metadata = uploadError.details.metadata;
            }
          }

          logger.debug('Error uploading tag icon to CDN:', uploadError);
          return res.status(statusCode).json(errorResponse);
        }

        // Generic error handling
        logger.error('Error uploading tag icon to CDN:', uploadError);
        return res.status(500).json({
          error: 'Failed to upload icon to CDN',
          details: uploadError instanceof Error ? uploadError.message : String(uploadError)
        });
      }
    } else if (icon === 'null' || icon === null) {
      // Priority 2 - null explicitly passed -> no icon
      finalIconUrl = null;
    } else if (icon) {
      // If icon is provided as a string (existing URL), use it
      finalIconUrl = icon;
    }

    // Get the last sort order to append new tag at the end
    const lastSortOrder = await LevelTag.max('sortOrder') as number || 0;

    // Determine groupSortOrder: use existing group's value or create new one
    let groupSortOrder = 0;
    if (group) {
      // Check if group already exists
      const existingGroupTag = await LevelTag.findOne({
        where: { group },
        transaction
      });
      if (existingGroupTag) {
        groupSortOrder = existingGroupTag.groupSortOrder;
      } else {
        // New group - get max groupSortOrder and add 1
        const maxGroupSortOrder = await LevelTag.max('groupSortOrder', { transaction }) as number || 0;
        groupSortOrder = maxGroupSortOrder + 1;
      }
    } else {
      // Ungrouped tags - check for existing ungrouped tags
      const existingUngroupedTag = await LevelTag.findOne({
        where: { [Op.or]: [{ group: null }, { group: '' }] },
        transaction
      });
      if (existingUngroupedTag) {
        groupSortOrder = existingUngroupedTag.groupSortOrder;
      } else {
        const maxGroupSortOrder = await LevelTag.max('groupSortOrder', { transaction }) as number || 0;
        groupSortOrder = maxGroupSortOrder + 1;
      }
    }

    const tag = await LevelTag.create({
      name,
      icon: finalIconUrl,
      color,
      group: group || null,
      sortOrder: lastSortOrder + 1,
      groupSortOrder,
      createdAt: new Date(),
      updatedAt: new Date(),
    }, { transaction });

    await transaction.commit();

    await updateDifficultiesHash();

    return res.status(201).json(tag);
  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error creating tag:', error);
    return res.status(500).json({ error: 'Failed to create tag' });
  }
});

// Update tag
router.put('/tags/:id([0-9]{1,20})', Auth.superAdminPassword(), tagIconUpload.single('icon'), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  try {
    const tagId = parseInt(req.params.id);
    const { name, color, icon, group } = req.body;
    const iconFile = req.file;

    const tag = await LevelTag.findByPk(tagId);
    if (!tag) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({ error: 'Tag not found' });
    }

    // Validate accent color format if provided
    if (color && !/^#[0-9A-Fa-f]{6}$/.test(color)) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'Invalid accent color format. Must be a hex color (e.g., #FF5733)' });
    }

    // Check for name duplication if name is being changed
    if (name && name !== tag.name) {
      const existingTag = await LevelTag.findOne({ where: { name } });
      if (existingTag) {
        await safeTransactionRollback(transaction);
        return res.status(400).json({ error: 'A tag with this name already exists' });
      }
    }

    // Handle icon update with priority logic:
    // Priority 1: file attached -> update icon
    // Priority 2: null as link -> remove icon if exists
    // Otherwise: no change
    let finalIconUrl: string | null | undefined = undefined;
    let oldFileId: string | null = null;

    if (iconFile) {
      // Priority 1: File attached -> upload new icon
      try {
        // Extract old file ID for cleanup if exists
        if (tag.icon && isCdnUrl(tag.icon)) {
          oldFileId = getFileIdFromCdnUrl(tag.icon);
        }

        const uploadResult = await cdnService.uploadTagIcon(
          iconFile.buffer,
          iconFile.originalname
        );
        finalIconUrl = uploadResult.urls.original;
      } catch (uploadError) {
        await safeTransactionRollback(transaction);

        // Handle CdnError with validation details
        if (uploadError instanceof CdnError) {
          const statusCode = uploadError.code === 'VALIDATION_ERROR' ? 400 : 500;
          const errorResponse: any = {
            error: uploadError.message,
            code: uploadError.code
          };

          // Include validation error details if available
          if (uploadError.details) {
            if (uploadError.details.errors) {
              errorResponse.errors = uploadError.details.errors;
            }
            if (uploadError.details.warnings) {
              errorResponse.warnings = uploadError.details.warnings;
            }
            if (uploadError.details.metadata) {
              errorResponse.metadata = uploadError.details.metadata;
            }
          }

          logger.error('Error uploading tag icon to CDN:', uploadError);
          return res.status(statusCode).json(errorResponse);
        }

        // Generic error handling
        logger.error('Error uploading tag icon to CDN:', uploadError);
        return res.status(500).json({
          error: 'Failed to upload icon to CDN',
          details: uploadError instanceof Error ? uploadError.message : String(uploadError)
        });
      }
    } else if (icon === 'null' || icon === null) {
      // Priority 2: null explicitly passed -> remove icon
      if (tag.icon && isCdnUrl(tag.icon)) {
        oldFileId = getFileIdFromCdnUrl(tag.icon);
      }
      finalIconUrl = null;
    }
    // Otherwise: finalIconUrl remains undefined, which means no change

    // Determine groupSortOrder if group is being changed
    let groupSortOrder: number | undefined = undefined;
    const newGroup = group !== undefined ? (group || null) : tag.group;
    const isGroupChanging = group !== undefined && newGroup !== tag.group;

    if (isGroupChanging) {
      if (newGroup) {
        // Check if group already exists
        const existingGroupTag = await LevelTag.findOne({
          where: { group: newGroup },
          transaction
        });
        if (existingGroupTag) {
          groupSortOrder = existingGroupTag.groupSortOrder;
        } else {
          // New group - get max groupSortOrder and add 1
          const maxGroupSortOrder = await LevelTag.max('groupSortOrder', { transaction }) as number || 0;
          groupSortOrder = maxGroupSortOrder + 1;
        }
      } else {
        // Ungrouped tags - check for existing ungrouped tags
        const existingUngroupedTag = await LevelTag.findOne({
          where: { [Op.or]: [{ group: null }, { group: '' }] },
          transaction
        });
        if (existingUngroupedTag) {
          groupSortOrder = existingUngroupedTag.groupSortOrder;
        } else {
          const maxGroupSortOrder = await LevelTag.max('groupSortOrder', { transaction }) as number || 0;
          groupSortOrder = maxGroupSortOrder + 1;
        }
      }
    }

    // Update the tag
    const updateData: any = {
      name: name ?? tag.name,
      icon: finalIconUrl !== undefined ? finalIconUrl : tag.icon,
      color: color ?? tag.color,
      group: newGroup,
      updatedAt: new Date(),
    };

    // Only update groupSortOrder if group is changing
    if (groupSortOrder !== undefined) {
      updateData.groupSortOrder = groupSortOrder;
    }

    await tag.update(updateData, { transaction });

    await transaction.commit();

    // Clean up old icon file from CDN after successful update
    // Do this after transaction commit so CDN cleanup failure doesn't prevent tag update
    // Only cleanup if we have an old file ID and the icon was actually changed (new icon uploaded or removed)
    if (oldFileId && (finalIconUrl !== undefined)) {
      try {
        logger.debug('Cleaning up old tag icon from CDN after tag update', {
          tagId,
          oldFileId,
          newIconUrl: finalIconUrl,
        });
        await cdnService.deleteFile(oldFileId);
        logger.debug('Successfully cleaned up old tag icon from CDN', {
          tagId,
          oldFileId,
        });
      } catch (cleanupError) {
        // Log cleanup error but don't fail the request since the tag was already updated
        logger.error('Failed to clean up old tag icon from CDN after tag update:', {
          tagId,
          oldFileId,
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      }
    }

    await updateDifficultiesHash();

    return res.json(tag);
  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error updating tag:', error);
    return res.status(500).json({ error: 'Failed to update tag' });
  }
});

// Delete tag
router.delete('/tags/:id([0-9]{1,20})', Auth.superAdminPassword(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  try {
    const tagId = parseInt(req.params.id);

    const tag = await LevelTag.findByPk(tagId);
    if (!tag) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({ error: 'Tag not found' });
    }

    // Check for assignments
    const assignments = await LevelTagAssignment.findAll({
      where: { tagId },
      transaction,
    });

    assignments.forEach(async (assignment) => {
      await assignment.destroy({ transaction });
    });

    // Extract file ID for cleanup if icon exists
    let fileId: string | null = null;
    if (tag.icon && isCdnUrl(tag.icon)) {
      fileId = getFileIdFromCdnUrl(tag.icon);
    }

    // Delete the tag
    await tag.destroy({ transaction });

    await transaction.commit();

    // Clean up icon file from CDN after successful deletion
    // Do this after transaction commit so CDN cleanup failure doesn't prevent tag deletion
    if (fileId) {
      try {
        logger.debug('Cleaning up tag icon from CDN after tag deletion', {
          tagId,
          fileId,
        });
        await cdnService.deleteFile(fileId);
        logger.debug('Successfully cleaned up tag icon from CDN', {
          tagId,
          fileId,
        });
      } catch (cleanupError) {
        // Log cleanup error but don't fail the request since the tag was already deleted
        logger.error('Failed to clean up tag icon from CDN after tag deletion:', {
          tagId,
          fileId,
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      }
    }

    await updateDifficultiesHash();

    return res.json({ message: 'Tag deleted successfully' });
  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error deleting tag:', error);
    return res.status(500).json({ error: 'Failed to delete tag' });
  }
});

// Get tags for a level
router.get('/levels/:levelId([0-9]{1,20})/tags', async (req: Request, res: Response) => {
  try {
    const levelId = parseInt(req.params.levelId);

    const level = await Level.findByPk(levelId);
    if (!level) {
      return res.status(404).json({ error: 'Level not found' });
    }

    // Query tags through the join table
    const assignments = await LevelTagAssignment.findAll({
      where: { levelId },
    });

    const assignmentTagIds = assignments.map(a => a.tagId);
    const tags = await LevelTag.findAll({
      where: { id: { [Op.in]: assignmentTagIds } },
      order: [['name', 'ASC']],
    });

    return res.json(tags);
  } catch (error) {
    logger.error('Error fetching level tags:', error);
    return res.status(500).json({ error: 'Failed to fetch level tags' });
  }
});

// Assign tags to level
router.post('/levels/:levelId([0-9]{1,20})/tags', Auth.superAdmin(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  try {
    const levelId = parseInt(req.params.levelId);
    const { tagIds } = req.body;

    if (!Array.isArray(tagIds)) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'tagIds must be an array' });
    }

    const level = await Level.findByPk(levelId, { transaction });
    if (!level) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({ error: 'Level not found' });
    }

    // Validate all tag IDs exist
    if (tagIds.length > 0) {
      const tags = await LevelTag.findAll({
        where: { id: { [Op.in]: tagIds } },
        transaction,
      });

      if (tags.length !== tagIds.length) {
        await safeTransactionRollback(transaction);
        return res.status(400).json({ error: 'One or more tag IDs are invalid' });
      }
    }

    // Remove all existing assignments
    await LevelTagAssignment.destroy({
      where: { levelId },
      transaction,
    });

    // Create new assignments
    if (tagIds.length > 0) {
      await LevelTagAssignment.bulkCreate(
        tagIds.map((tagId: number) => ({
          levelId,
          tagId,
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
        { transaction }
      );
    }

    await transaction.commit();

    // Fetch updated tags
    const assignments = await LevelTagAssignment.findAll({
      where: { levelId },
    });

    const assignmentTagIds = assignments.map(a => a.tagId);
    const updatedTags = await LevelTag.findAll({
      where: { id: { [Op.in]: assignmentTagIds } },
      order: [['name', 'ASC']],
    });

    return res.json(updatedTags);
  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error assigning tags to level:', error);
    return res.status(500).json({ error: 'Failed to assign tags to level' });
  }
});

export default router;
