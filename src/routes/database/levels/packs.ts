import { Router, Request, Response } from 'express';
import { Auth } from '../../../middleware/auth.js';
import { LevelPack, LevelPackItem, LevelPackViewModes, LevelPackCSSFlags } from '../../../models/packs/index.js';
import Level from '../../../models/levels/Level.js';
import { User } from '../../../models/index.js';
import { Op, Transaction } from 'sequelize';
import sequelize from '../../../config/db.js';
import { logger } from '../../../services/LoggerService.js';
import { hasFlag } from '../../../utils/permissionUtils.js';
import { permissionFlags } from '../../../config/constants.js';
import { safeTransactionRollback } from '../../../utils/Utility.js';
import { parseSearchQuery, extractFieldValues, extractGeneralSearchTerms, queryParserConfigs } from '../../../utils/queryParser.js';
import { getFileIdFromCdnUrl, isCdnUrl } from '../../../utils/Utility.js';
import multer from 'multer';
import cdnService from '../../../services/CdnService.js';
import { CdnError } from '../../../services/CdnService.js';

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

// Constants
const MAX_PACKS_PER_USER = 50;
const MAX_ITEMS_PER_PACK = 1000;
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

// Helper function to check if user can view pack
const canViewPack = (pack: LevelPack, user: any): boolean => {
  if (!pack) return false;
  
  // Owner can always view their own packs
  if (user && pack.ownerId === user.id) return true;
  
  // Admin can view all packs
  if (user && hasFlag(user, permissionFlags.SUPER_ADMIN)) return true;
  
  // Check view mode
  switch (pack.viewMode) {
    case LevelPackViewModes.PUBLIC:
      return true;
    case LevelPackViewModes.LINKONLY:
      return true;
    case LevelPackViewModes.PRIVATE:
      return false;
    case LevelPackViewModes.FORCED_PRIVATE:
      return false;
    default:
      return false;
  }
};

// Helper function to check if user can edit pack
const canEditPack = (pack: LevelPack, user: any): boolean => {
  if (!user || !pack) return false;
  
  // Owner can edit their own packs (unless forced private)
  if (pack.ownerId === user.id && pack.viewMode !== LevelPackViewModes.FORCED_PRIVATE) {
    return true;
  }
  
  // Admin can edit all packs
  return hasFlag(user, permissionFlags.SUPER_ADMIN);
};

// Helper function to build tree recursively from items
const buildItemTree = (items: LevelPackItem[], parentId: number | null = null): any[] => {
  const children = items.filter(item => item.parentId === parentId);
  
  return children.map(item => {
    const itemJson = item.toJSON();
    const subChildren = buildItemTree(items, item.id);
    
    return {
      ...itemJson,
      children: subChildren.length > 0 ? subChildren : undefined
    };
  });
};

// ==================== PACK OPERATIONS ====================

// GET /packs - List all packs
router.get('/', Auth.addUserToRequest(), async (req: Request, res: Response) => {
  try {
    const {
      query,
      ownerUsername,
      viewMode,
      pinned,
      offset = 0,
      limit = DEFAULT_LIMIT,
      sort = 'createdAt',
      order = 'DESC'
    } = req.query;

    const parsedLimit = Math.min(parseInt(limit as string) || DEFAULT_LIMIT, MAX_LIMIT);
    const parsedOffset = parseInt(offset as string) || 0;

    const whereConditions: any = {};

    // Filter by owner
    if (ownerUsername) {
      const owner = await User.findOne({
        where: { username: ownerUsername as string }
      });
      if (owner) {
        whereConditions.ownerId = owner.id;
      }
    }

    // Filter by view mode
    if (viewMode !== undefined) {
      const viewModeValue = parseInt(viewMode as string);
      if (!isNaN(viewModeValue)) {
        whereConditions.viewMode = viewModeValue;
      }
    } else if (!req.user || !whereConditions.ownerId || whereConditions.ownerId !== req.user.id) {
      // If not owner and not admin, only show public/linkonly
      if (!req.user || !hasFlag(req.user, permissionFlags.SUPER_ADMIN)) {
        whereConditions.viewMode = {
          [Op.in]: [LevelPackViewModes.PUBLIC, LevelPackViewModes.LINKONLY]
        };
      }
    }

    // Filter by pinned
    if (pinned !== undefined) {
      whereConditions.isPinned = pinned === 'true';
    }

    // Search by name
    if (query) {
      whereConditions.name = {
        [Op.like]: `%${query}%`
      };
    }

    // Fetch packs
    const result = await LevelPack.findAndCountAll({
      where: whereConditions,
      include: [{
        model: User,
        as: 'packOwner',
        attributes: ['id', 'nickname', 'username', 'avatarUrl']
      }],
      order: [[sort as string, order as string]],
      limit: parsedLimit,
      offset: parsedOffset,
      distinct: true
    });

    return res.json({
      packs: result.rows,
      total: result.count,
      offset: parsedOffset,
      limit: parsedLimit
    });

  } catch (error) {
    logger.error('Error fetching packs:', error);
    return res.status(500).json({ error: 'Failed to fetch packs' });
  }
});

// GET /packs/:id - Get specific pack with its content tree
router.get('/:id', Auth.addUserToRequest(), async (req: Request, res: Response) => {
  try {
    const packId = parseInt(req.params.id);
    const { tree = 'true' } = req.query;

    if (isNaN(packId)) {
      return res.status(400).json({ error: 'Invalid pack ID' });
    }

    const pack = await LevelPack.findByPk(packId, {
      include: [{
        model: User,
        as: 'packOwner',
        attributes: ['id', 'nickname', 'username', 'avatarUrl']
      }]
    });

    if (!pack) {
      return res.status(404).json({ error: 'Pack not found' });
    }

    if (!canViewPack(pack, req.user)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Fetch all items in the pack
    const items = await LevelPackItem.findAll({
      where: { packId },
      include: [{
        model: Level,
        as: 'referencedLevel',
        required: false
      }],
      order: [['sortOrder', 'ASC']]
    });

    const packData: any = pack.toJSON();

    if (tree === 'true') {
      // Build tree structure
      packData.items = buildItemTree(items);
    } else {
      // Flat list
      packData.items = items;
    }

    return res.json(packData);

  } catch (error) {
    logger.error('Error fetching pack:', error);
    return res.status(500).json({ error: 'Failed to fetch pack' });
  }
});

// POST /packs - Create new pack
router.post('/', Auth.user(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  
  try {
    const { name, iconUrl, cssFlags, viewMode, isPinned } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'Pack name is required' });
    }

    const queriedUser = await User.findOne({
      where: { username: req.user!.username },
      transaction
    });

    // Check pack limit for user
    const userPackCount = await LevelPack.count({
      where: { ownerId: queriedUser!.id },
      transaction
    });

    if (userPackCount >= MAX_PACKS_PER_USER) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: `Maximum ${MAX_PACKS_PER_USER} packs allowed per user` });
    }

    const pack = await LevelPack.create({
      ownerId: queriedUser!.id,
      name: name.trim(),
      iconUrl: iconUrl || null,
      cssFlags: cssFlags || 0,
      viewMode: viewMode || LevelPackViewModes.PUBLIC,
      isPinned: isPinned || false
    }, { transaction });

    await transaction.commit();

    return res.status(201).json(pack);

  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error creating pack:', error);
    return res.status(500).json({ error: 'Failed to create pack' });
  }
});

// PUT /packs/:id - Update pack
router.put('/:id', Auth.user(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  
  try {
    const packId = parseInt(req.params.id);
    if (isNaN(packId)) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'Invalid pack ID' });
    }

    const pack = await LevelPack.findByPk(packId, { transaction });
    if (!pack) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({ error: 'Pack not found' });
    }

    if (!canEditPack(pack, req.user)) {
      await safeTransactionRollback(transaction);
      return res.status(403).json({ error: 'Access denied' });
    }

    const { name, iconUrl, cssFlags, viewMode, isPinned } = req.body;
    const updateData: any = {};

    if (name !== undefined) {
      if (typeof name !== 'string' || name.trim().length === 0) {
        await safeTransactionRollback(transaction);
        return res.status(400).json({ error: 'Pack name cannot be empty' });
      }
      updateData.name = name.trim();
    }

    if (iconUrl !== undefined) updateData.iconUrl = iconUrl;
    if (cssFlags !== undefined) updateData.cssFlags = cssFlags;
    if (isPinned !== undefined) updateData.isPinned = isPinned;

    // Only allow viewMode changes if user is admin or it's not forced private
    if (viewMode !== undefined) {
      if (pack.viewMode === LevelPackViewModes.FORCED_PRIVATE && !hasFlag(req.user, permissionFlags.SUPER_ADMIN)) {
        await safeTransactionRollback(transaction);
        return res.status(403).json({ error: 'Cannot modify view mode of admin-locked pack' });
      }
      updateData.viewMode = viewMode;
    }

    await pack.update(updateData, { transaction });
    await transaction.commit();

    return res.json(pack);

  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error updating pack:', error);
    return res.status(500).json({ error: 'Failed to update pack' });
  }
});

// DELETE /packs/:id - Delete pack
router.delete('/:id', Auth.user(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  
  try {
    const packId = parseInt(req.params.id);
    if (isNaN(packId)) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'Invalid pack ID' });
    }

    const pack = await LevelPack.findByPk(packId, { transaction });
    if (!pack) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({ error: 'Pack not found' });
    }

    if (!canEditPack(pack, req.user)) {
      await safeTransactionRollback(transaction);
      return res.status(403).json({ error: 'Access denied' });
    }

    await pack.destroy({ transaction });
    await transaction.commit();

    return res.status(204).end();

  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error deleting pack:', error);
    return res.status(500).json({ error: 'Failed to delete pack' });
  }
});

// POST /packs/:id/icon - Upload pack icon
router.post('/:id/icon', Auth.user(), upload.single('icon'), async (req: Request, res: Response) => {
    try {
        const packId = parseInt(req.params.id);
        if (isNaN(packId)) {
            return res.status(400).json({ error: 'Invalid pack ID' });
        }

        const pack = await LevelPack.findByPk(packId);
        if (!pack) {
            return res.status(404).json({ error: 'Pack not found' });
        }

        if (!canEditPack(pack, req.user)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        if (!req.file) {
            return res.status(400).json({
                error: 'No file uploaded',
                code: 'NO_FILE'
            });
        }

        const result = await cdnService.uploadPackIcon(
            req.file.buffer,
            req.file.originalname
        );

        // Delete old icon if it exists
        try {
            if (pack.iconUrl && isCdnUrl(pack.iconUrl)) {
                const oldFileId = getFileIdFromCdnUrl(pack.iconUrl);
                if (oldFileId && await cdnService.checkFileExists(oldFileId)) {
                    await cdnService.deleteFile(oldFileId);
                }
            }
        } catch (error) {
            logger.error('Error deleting old pack icon from CDN:', error);
        }

        await pack.update({
            iconUrl: result.urls.original
        });

        return res.json({
            message: 'Pack icon uploaded successfully',
            icon: {
                id: result.fileId,
                urls: result.urls,
            }
        });
    } catch (error) {
        logger.error('Error uploading pack icon:', error);
        
        if (error instanceof CdnError) {
            return res.status(400).json({
                error: error.message,
                code: error.code,
                details: error.details
            });
        }
        
        return res.status(500).json({
            error: 'Failed to upload pack icon',
            code: 'SERVER_ERROR',
            details: error instanceof Error ? error.message : String(error)
        });
    }
});

// DELETE /packs/:id/icon - Remove pack icon
router.delete('/:id/icon', Auth.user(), async (req: Request, res: Response) => {
    try {
        const packId = parseInt(req.params.id);
        if (isNaN(packId)) {
            return res.status(400).json({ error: 'Invalid pack ID' });
        }

        const pack = await LevelPack.findByPk(packId);
        if (!pack) {
            return res.status(404).json({ error: 'Pack not found' });
        }

        if (!canEditPack(pack, req.user)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        if (!pack.iconUrl || !isCdnUrl(pack.iconUrl)) {
            return res.status(400).json({ error: 'No icon to remove' });
        }

        const oldFileId = getFileIdFromCdnUrl(pack.iconUrl);

        await pack.update({
            iconUrl: null
        });

        try {
            if (oldFileId) {
                await cdnService.deleteFile(oldFileId);
            }
        } catch (error) {
            logger.error('Error deleting old pack icon from CDN:', error);
        }

        return res.json({ message: 'Pack icon removed successfully' });
    } catch (error) {
        logger.error('Error removing pack icon:', error);
        return res.status(500).json({ error: 'Failed to remove pack icon' });
    }
});

// ==================== PACK ITEM OPERATIONS ====================

// POST /packs/:id/items - Add item (folder or level) to pack
router.post('/:id/items', Auth.user(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  
  try {
    const packId = parseInt(req.params.id);
    const { type, name, levelId, parentId, sortOrder } = req.body;

    if (isNaN(packId)) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'Invalid pack ID' });
    }

    if (!type || (type !== 'folder' && type !== 'level')) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'Type must be "folder" or "level"' });
    }

    const pack = await LevelPack.findByPk(packId, { transaction });
    if (!pack) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({ error: 'Pack not found' });
    }

    if (!canEditPack(pack, req.user)) {
      await safeTransactionRollback(transaction);
      return res.status(403).json({ error: 'Access denied' });
    }

    // Validate based on type
    if (type === 'folder') {
      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        await safeTransactionRollback(transaction);
        return res.status(400).json({ error: 'Folder name is required' });
      }

      // Check for duplicate folder name in same parent
      const existingFolder = await LevelPackItem.findOne({
        where: {
          packId,
          type: 'folder',
          parentId: parentId || null,
          name: name.trim()
        },
        transaction
      });

      if (existingFolder) {
        await safeTransactionRollback(transaction);
        return res.status(400).json({ error: 'Folder with this name already exists in this location' });
      }
    } else {
      // type === 'level'
      if (!levelId || isNaN(parseInt(levelId))) {
        await safeTransactionRollback(transaction);
        return res.status(400).json({ error: 'Valid level ID is required' });
      }

      const level = await Level.findByPk(parseInt(levelId), { transaction });
      if (!level) {
        await safeTransactionRollback(transaction);
        return res.status(404).json({ error: 'Level not found' });
      }

      // Check if level is already in pack
      const existingItem = await LevelPackItem.findOne({
        where: { packId, type: 'level', levelId: parseInt(levelId) },
        transaction
      });

      if (existingItem) {
        await safeTransactionRollback(transaction);
        return res.status(400).json({ error: 'Level already in pack' });
      }
    }

    // Validate parent if provided
    if (parentId) {
      const parent = await LevelPackItem.findOne({
        where: { id: parentId, packId, type: 'folder' },
        transaction
      });

      if (!parent) {
        await safeTransactionRollback(transaction);
        return res.status(400).json({ error: 'Invalid parent folder' });
      }
    }

    // Check item limit
    const itemCount = await LevelPackItem.count({
      where: { packId },
      transaction
    });

    if (itemCount >= MAX_ITEMS_PER_PACK) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: `Maximum ${MAX_ITEMS_PER_PACK} items allowed per pack` });
    }

    // Determine sort order
    let finalSortOrder = sortOrder;
    if (finalSortOrder === undefined || finalSortOrder === null) {
      const maxSortOrder = await LevelPackItem.max('sortOrder', {
        where: { packId, parentId: parentId || null },
        transaction
      });
      finalSortOrder = (maxSortOrder as number || 0) + 1;
    }

    const item = await LevelPackItem.create({
      packId,
      type,
      parentId: parentId || null,
      name: type === 'folder' ? name.trim() : null,
      levelId: type === 'level' ? parseInt(levelId) : null,
      sortOrder: finalSortOrder
    }, { transaction });

    await transaction.commit();

    // Return the item with level data if applicable
    const result = await LevelPackItem.findByPk(item.id, {
      include: type === 'level' ? [{
        model: Level,
        as: 'referencedLevel'
      }] : []
    });

    return res.status(201).json(result);

  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error adding item to pack:', error);
    return res.status(500).json({ error: 'Failed to add item to pack' });
  }
});

// PUT /packs/:id/items/:itemId - Update item
router.put('/:id/items/:itemId', Auth.user(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  
  try {
    const packId = parseInt(req.params.id);
    const itemId = parseInt(req.params.itemId);

    if (isNaN(packId) || isNaN(itemId)) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'Invalid pack ID or item ID' });
    }

    const pack = await LevelPack.findByPk(packId, { transaction });
    if (!pack) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({ error: 'Pack not found' });
    }

    if (!canEditPack(pack, req.user)) {
      await safeTransactionRollback(transaction);
      return res.status(403).json({ error: 'Access denied' });
    }

    const item = await LevelPackItem.findOne({
      where: { id: itemId, packId },
      transaction
    });

    if (!item) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({ error: 'Item not found in pack' });
    }

    const { name } = req.body;
    
    if (item.type === 'folder' && name !== undefined) {
      if (typeof name !== 'string' || name.trim().length === 0) {
        await safeTransactionRollback(transaction);
        return res.status(400).json({ error: 'Folder name cannot be empty' });
      }

      // Check for duplicate folder name in same parent
      const existingFolder = await LevelPackItem.findOne({
        where: {
          packId,
          type: 'folder',
          parentId: item.parentId,
          name: name.trim(),
          id: { [Op.ne]: itemId }
        },
        transaction
      });

      if (existingFolder) {
        await safeTransactionRollback(transaction);
        return res.status(400).json({ error: 'Folder with this name already exists in this location' });
      }

      await item.update({ name: name.trim() }, { transaction });
    }

    await transaction.commit();

    return res.json(item);

  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error updating pack item:', error);
    return res.status(500).json({ error: 'Failed to update pack item' });
  }
});

// PUT /packs/:id/items/:itemId/move - Move item to different parent
router.put('/:id/items/:itemId/move', Auth.user(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  
  try {
    const packId = parseInt(req.params.id);
    const itemId = parseInt(req.params.itemId);
    const { parentId, itemsToReorder } = req.body;

    if (isNaN(packId) || isNaN(itemId)) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'Invalid pack ID or item ID' });
    }

    const pack = await LevelPack.findByPk(packId, { transaction });
    if (!pack) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({ error: 'Pack not found' });
    }

    if (!canEditPack(pack, req.user)) {
      await safeTransactionRollback(transaction);
      return res.status(403).json({ error: 'Access denied' });
    }

    const item = await LevelPackItem.findOne({
      where: { id: itemId, packId },
      transaction
    });

    if (!item) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({ error: 'Item not found in pack' });
    }

    // Prevent moving item into itself
    if (parentId === itemId) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'Cannot move item into itself' });
    }

    // Validate new parent
    if (parentId) {
      const newParent = await LevelPackItem.findOne({
        where: { id: parentId, packId, type: 'folder' },
        transaction
      });

      if (!newParent) {
        await safeTransactionRollback(transaction);
        return res.status(400).json({ error: 'Invalid parent folder' });
      }

      // Check for circular reference (only for folders)
      if (item.type === 'folder') {
        let currentParentId = newParent.parentId;
        while (currentParentId) {
          if (currentParentId === itemId) {
            await safeTransactionRollback(transaction);
            return res.status(400).json({ error: 'Cannot move folder into its own descendant' });
          }
          const parent = await LevelPackItem.findByPk(currentParentId, { transaction });
          currentParentId = parent?.parentId || null;
        }
      }
    }

    // If itemsToReorder is provided, batch update all items in the destination parent
    if (itemsToReorder && Array.isArray(itemsToReorder)) {
      // Validate that all items belong to the pack and new parent
      const itemIds = itemsToReorder.map(i => i.id);
      const itemsInParent = await LevelPackItem.findAll({
        where: {
          packId,
          id: { [Op.in]: itemIds }
        },
        transaction
      });

      if (itemsInParent.length !== itemIds.length) {
        await safeTransactionRollback(transaction);
        return res.status(400).json({ error: 'Invalid items in reorder list' });
      }

      // Update all items including the moved item
      for (const { id, sortOrder } of itemsToReorder) {
        await LevelPackItem.update(
          {
            parentId: parentId || null,
            sortOrder
          },
          {
            where: { id, packId },
            transaction
          }
        );
      }
    } else {
      // Legacy behavior: just append to end
      const maxSortOrder = await LevelPackItem.max('sortOrder', {
        where: {
          packId,
          parentId: parentId || null
        },
        transaction
      });

      await item.update({
        parentId: parentId || null,
        sortOrder: (maxSortOrder as number || 0) + 1
      }, { transaction });
    }

    await transaction.commit();

    // Return updated item
    const updatedItem = await LevelPackItem.findByPk(itemId);
    return res.json(updatedItem);

  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error moving pack item:', error);
    return res.status(500).json({ error: 'Failed to move pack item' });
  }
});

// DELETE /packs/:id/items/:itemId - Delete item
router.delete('/:id/items/:itemId', Auth.user(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  
  try {
    const packId = parseInt(req.params.id);
    const itemId = parseInt(req.params.itemId);

    if (isNaN(packId) || isNaN(itemId)) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'Invalid pack ID or item ID' });
    }

    const pack = await LevelPack.findByPk(packId, { transaction });
    if (!pack) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({ error: 'Pack not found' });
    }

    if (!canEditPack(pack, req.user)) {
      await safeTransactionRollback(transaction);
      return res.status(403).json({ error: 'Access denied' });
    }

    const item = await LevelPackItem.findOne({
      where: { id: itemId, packId },
      transaction
    });

    if (!item) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({ error: 'Item not found in pack' });
    }

    // Check if folder has children
    if (item.type === 'folder') {
      const childCount = await LevelPackItem.count({
        where: { packId, parentId: itemId },
        transaction
      });

      if (childCount > 0) {
        await safeTransactionRollback(transaction);
        return res.status(400).json({ 
          error: 'Cannot delete folder that contains items',
          details: { children: childCount }
        });
      }
    }

    await item.destroy({ transaction });
    await transaction.commit();

    return res.status(204).end();

  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error deleting pack item:', error);
    return res.status(500).json({ error: 'Failed to delete pack item' });
  }
});

// PUT /packs/:id/items/reorder - Reorder multiple items
router.put('/:id/items/reorder', Auth.user(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  
  try {
    const packId = parseInt(req.params.id);
    const { items } = req.body;

    if (isNaN(packId)) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'Invalid pack ID' });
    }

    if (!Array.isArray(items)) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'items must be an array' });
    }

    const pack = await LevelPack.findByPk(packId, { transaction });
    if (!pack) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({ error: 'Pack not found' });
    }

    if (!canEditPack(pack, req.user)) {
      await safeTransactionRollback(transaction);
      return res.status(403).json({ error: 'Access denied' });
    }

    // Update item sort orders and optionally parent
    for (const { id, sortOrder, parentId } of items) {
      if (id && sortOrder !== undefined) {
        const updateData: any = { sortOrder };
        if (parentId !== undefined) {
          updateData.parentId = parentId || null;
        }

        await LevelPackItem.update(
          updateData,
          {
            where: { id, packId },
            transaction
          }
        );
      }
    }

    await transaction.commit();

    return res.json({ success: true });

  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error reordering pack items:', error);
    return res.status(500).json({ error: 'Failed to reorder pack items' });
  }
});

export default router;