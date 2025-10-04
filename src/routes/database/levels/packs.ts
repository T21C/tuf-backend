import { Router, Request, Response } from 'express';
import { Auth } from '../../../middleware/auth.js';
import { LevelPack, LevelPackItem, PackFavorite, LevelPackViewModes, LevelPackCSSFlags } from '../../../models/packs/index.js';
import Level from '../../../models/levels/Level.js';
import { User } from '../../../models/index.js';
import { Op, Transaction } from 'sequelize';
import sequelize from '../../../config/db.js';
import { logger } from '../../../services/LoggerService.js';
import { hasFlag } from '../../../utils/permissionUtils.js';
import { permissionFlags } from '../../../config/constants.js';
import { safeTransactionRollback } from '../../../utils/Utility.js';
import { parseSearchQuery, extractFieldValues, extractGeneralSearchTerms, queryParserConfigs, type FieldSearch, type SearchGroup } from '../../../utils/queryParser.js';
import { getFileIdFromCdnUrl, isCdnUrl } from '../../../utils/Utility.js';
import multer from 'multer';
import cdnService from '../../../services/CdnService.js';
import { CdnError } from '../../../services/CdnService.js';
import Pass from '../../../models/passes/Pass.js';

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
const buildItemTree = (items: any[], parentId: number | null = null): any[] => {
  const children = items.filter(item => {
    // Handle both Sequelize model instances and plain objects
    const itemParentId = item.parentId;
    return itemParentId === parentId;
  });
  
  return children.map(item => {
    // Handle both Sequelize model instances and plain objects
    const itemId = item.id;
    const subChildren = buildItemTree(items, itemId);
    
    return {
      ...item,
      children: subChildren.length > 0 ? subChildren : undefined
    };
  });
};

// Helper function to resolve pack ID from parameter (supports both numerical ID and linkCode)
const resolvePackId = async (param: string): Promise<number | null> => {
  // Check if parameter looks like a linkCode (alphanumeric)
  if (/^[A-Za-z0-9]+$/.test(param)) {
    // Try to find by linkCode first
    const pack = await LevelPack.findOne({
      where: { linkCode: param }
    });

    if (pack) {
      return pack.id;
    }
  }

  return null;
};

// Helper function to gather pack IDs based on search criteria
const gatherPackIdsFromSearch = async (searchGroups: SearchGroup[]): Promise<Set<number>> => {
  if (searchGroups.length === 0) {
    return new Set(); // No search criteria, return empty set
  }

  // Process each group (OR logic between groups)
  const groupResults: Set<number>[] = [];

  for (const group of searchGroups) {
    const groupPackIdSets: Set<number>[] = [];

    // Process each term within the group (AND logic within groups)
    for (const term of group.terms) {
      const { field, value, exact, isNot } = term;
      let packIds: number[] = [];

      if (field === 'any' || field === 'name') {
        // Pack name search
        const whereCondition = exact 
          ? { name: isNot ? { [Op.ne]: value } : value }
          : { name: isNot ? { [Op.notLike]: `%${value}%` } : { [Op.like]: `%${value}%` } };
        
        const packs = await LevelPack.findAll({
          where: whereCondition,
          attributes: ['id']
        });
        packIds = packs.map(pack => pack.id);
      } else if (field === 'owner') {
        // Owner username search
        const whereCondition = exact 
          ? { username: isNot ? { [Op.ne]: value } : value }
          : { username: isNot ? { [Op.notLike]: `%${value}%` } : { [Op.like]: `%${value}%` } };
        
        const owners = await User.findAll({
          where: whereCondition,
          attributes: ['id']
        });
        
        if (owners.length > 0) {
          const ownerIds = owners.map(owner => owner.id);
          const packs = await LevelPack.findAll({
            where: { ownerId: { [Op.in]: ownerIds } },
            attributes: ['id']
          });
          packIds = packs.map(pack => pack.id);
        }
      } else if (field === 'levelid') {
        // Level ID search - find packs containing this level
        const levelId = parseInt(value);
        if (!isNaN(levelId)) {
          const whereCondition = {
            type: 'level',
            levelId: isNot ? { [Op.ne]: levelId } : levelId
          };
          
          const packItems = await LevelPackItem.findAll({
            where: whereCondition,
            attributes: ['packId']
          });
          packIds = packItems.map(item => item.packId);
          
          // If NOT search, we need to find packs that don't contain this level
          if (isNot) {
            const allPacks = await LevelPack.findAll({
              attributes: ['id']
            });
            const allPackIds = allPacks.map(pack => pack.id);
            const containingPackIds = new Set(packIds);
            packIds = allPackIds.filter(id => !containingPackIds.has(id));
          }
        }
      } else if (field === 'viewmode') {
        // View mode search
        const viewMode = parseInt(value);
        if (!isNaN(viewMode)) {
          const whereCondition = { viewMode: isNot ? { [Op.ne]: viewMode } : viewMode };
          const packs = await LevelPack.findAll({
            where: whereCondition,
            attributes: ['id']
          });
          packIds = packs.map(pack => pack.id);
        }
      } else if (field === 'pinned') {
        // Pinned status search
        const pinned = value.toLowerCase() === 'true';
        const whereCondition = { isPinned: isNot ? !pinned : pinned };
        const packs = await LevelPack.findAll({
          where: whereCondition,
          attributes: ['id']
        });
        packIds = packs.map(pack => pack.id);
      }

      if (packIds.length > 0) {
        groupPackIdSets.push(new Set(packIds));
      }
    }

    // Combine terms within group using intersection (AND logic)
    if (groupPackIdSets.length > 0) {
      let groupResult = groupPackIdSets[0];
      for (let i = 1; i < groupPackIdSets.length; i++) {
        groupResult = new Set([...groupResult].filter(id => groupPackIdSets[i].has(id)));
      }
      groupResults.push(groupResult);
    }
  }

  // Combine groups using union (OR logic)
  if (groupResults.length === 0) {
    return new Set();
  }

  let finalResult = groupResults[0];
  for (let i = 1; i < groupResults.length; i++) {
    finalResult = new Set([...finalResult, ...groupResults[i]]);
  }

  return finalResult;
};

// ==================== PACK OPERATIONS ====================

// GET /packs - List all packs
router.get('/', Auth.addUserToRequest(), async (req: Request, res: Response) => {
  try {
    const {
      query,
      viewMode,
      pinned,
      myLikesOnly,
      offset = 0,
      limit = DEFAULT_LIMIT,
      sort = 'createdAt',
      order = 'DESC'
    } = req.query;

    const parsedLimit = Math.min(parseInt(limit as string) || DEFAULT_LIMIT, MAX_LIMIT);
    const parsedOffset = parseInt(offset as string) || 0;

    const whereConditions: any = {};


    // Filter by view mode
    if (viewMode !== undefined && hasFlag(req.user, permissionFlags.SUPER_ADMIN)) {
      const viewModeValue = parseInt(viewMode as string);
      if (!isNaN(viewModeValue)) {
        whereConditions.viewMode = viewModeValue;
      }
    }
    
    const ownPacks = req.user ? await LevelPack.findAll({
      where: { ownerId: req.user.id }
    }) : [];
    const ownPackIds = new Set(ownPacks.map(pack => pack.id));

    // Filter by pinned
    if (pinned !== undefined) {
      whereConditions.isPinned = pinned === 'true';
    }

    // Step 1: Handle myLikesOnly filter - get user's favorited pack IDs
    let favoritedPackIds: Set<number> | null = null;
    if (myLikesOnly === 'true' && req.user?.id) {
      const favorites = await PackFavorite.findAll({
        where: { userId: req.user.id },
        attributes: ['packId']
      });
      favoritedPackIds = new Set(favorites.map(fav => fav.packId));

      if (favoritedPackIds.size === 0) {
        // User has no favorites, return empty response
        return res.json({
          packs: [],
          total: 0,
          offset: parsedOffset,
          limit: parsedLimit
        });
      }
    }

    // Step 2: Gather pack IDs from search criteria
    let searchPackIds: Set<number> | null = null;
    if (query) {
      const searchGroups = parseSearchQuery(query as string, queryParserConfigs.pack);
      searchPackIds = await gatherPackIdsFromSearch(searchGroups);

      // If search returned no results, return empty response
      if (searchPackIds.size === 0) {
        return res.json({
          packs: [],
          total: 0,
          offset: parsedOffset,
          limit: parsedLimit
        });
      }
    }

    // Step 3: Combine filters - intersection of favorites and search results
    if (favoritedPackIds && searchPackIds) {
      // Intersection of both sets
      searchPackIds = new Set([...searchPackIds].filter(id => favoritedPackIds!.has(id)));
    } else if (favoritedPackIds) {
      // Only favorites filter
      searchPackIds = favoritedPackIds;
    }

    // Step 4: Apply search pack IDs to where conditions
    if (searchPackIds && searchPackIds.size > 0) {
      whereConditions.id = { [Op.in]: Array.from(searchPackIds) };
    }

    // Fetch packs with proper includes
    const result = await LevelPack.findAndCountAll({
      where: whereConditions,
      include: [{
        model: User,
        as: 'packOwner',
        attributes: ['id', 'nickname', 'username', 'avatarUrl']
      },
      {
        model: LevelPackItem,
        as: 'packItems',
        include: [{
          model: Level,
          as: 'referencedLevel',
          required: false
        }],
        required: false
      }
    ],
      order: [[sort as string, order as string]],
      limit: parsedLimit,
      offset: parsedOffset,
      distinct: true
    });

    const favoritedPacks = req.user ? await PackFavorite.findAll({
      where: {
        userId: req.user.id
      }
    }) : [];

    const viewModeFilter = (pack: LevelPack) => {
      if (hasFlag(req.user, permissionFlags.SUPER_ADMIN)) return true;
      if (ownPackIds.has(pack.id)) return true;
      if (pack.viewMode === LevelPackViewModes.PUBLIC) return true;
      return false;
    };

    const ownerFilteredPacks = result.rows.filter(viewModeFilter);
    return res.json({
      packs: ownerFilteredPacks.map(pack => ({
        ...pack.toJSON(),
        id: pack.linkCode,
        isFavorited: favoritedPacks.some(favorite => favorite.packId === pack.id)
      })),
      total: ownerFilteredPacks.length,
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
    const param = req.params.id;
    const { tree = 'true' } = req.query;

    let pack = null;
    let packId = null;

    // Check if parameter looks like a linkCode (alphanumeric)
    if (/^[A-Za-z0-9]+$/.test(param)) {
      // Try to find by linkCode first
      pack = await LevelPack.findOne({
        where: { linkCode: param },
        include: [{
          model: User,
          as: 'packOwner',
          attributes: ['id', 'nickname', 'username', 'avatarUrl']
        }]
      });

      if (pack) {
        packId = pack.id;
      }
    }

    // If not found by linkCode or parameter looks like a number, try numerical ID
    if (!pack) {
      packId = parseInt(param);
      if (isNaN(packId)) {
        return res.status(400).json({ error: 'Invalid pack ID or link code' });
      }

      pack = await LevelPack.findByPk(packId, {
        include: [{
          model: User,
          as: 'packOwner',
          attributes: ['id', 'nickname', 'username', 'avatarUrl']
        }]
      });
    }

    if (!pack) {
      return res.status(404).json({ error: 'Pack not found' });
    }

    if (!canViewPack(pack, req.user)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Fetch all items in the pack
    let items = await LevelPackItem.findAll({
      where: { packId: pack.id },
      include: [{
        model: Level,
        as: 'referencedLevel',
        required: false
      }],
      order: [['sortOrder', 'ASC']]
    });

    let clearedLevelIds: number[] = [];
    if (req.user) {
    clearedLevelIds = await Pass.findAll({
      where: { playerId: req.user.playerId, isDeleted: false },
      attributes: ['levelId']
    }).then(levels => levels.map(level => level.levelId));
  }

    const packData: any = pack.toJSON();

    items = items.map((item: any) => ({
      ...item.dataValues,
      isCleared: clearedLevelIds.includes(item.levelId || 0)
    }));

    

    if (tree === 'true') {
      // Build tree structure
      packData.items = buildItemTree(items);
    } else {
      // Flat list
      packData.items = items;
    }

    return res.json({
      ...packData,
      id: packData.linkCode,
    });

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

    // Only allow admins to create public packs or set pin status
    let finalViewMode;
    let finalIsPinned = false;

    if (hasFlag(req.user, permissionFlags.SUPER_ADMIN)) {
      // Admins can set any view mode, default to public
      finalViewMode = viewMode || LevelPackViewModes.PUBLIC;
      finalIsPinned = isPinned || false;
    } else {
      // Non-admins can only create private or link-only packs, never public
      if (viewMode === LevelPackViewModes.PUBLIC) {
        await safeTransactionRollback(transaction);
        return res.status(403).json({ error: 'Only administrators can create public packs' });
      }
      finalViewMode = viewMode || LevelPackViewModes.PRIVATE;
      // Non-admins cannot set pin status
      if (isPinned) {
        await safeTransactionRollback(transaction);
        return res.status(403).json({ error: 'Only administrators can set pack pin status' });
      }
    }

    // Generate unique linkCode
    const generateLinkCode = () => {
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
      let result = '';
      for (let i = 0; i < 8; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      return result;
    };

    let linkCode = generateLinkCode();
    let attempts = 0;
    const maxAttempts = 50;

    // Ensure uniqueness
    while (attempts < maxAttempts) {
      const existingPack = await LevelPack.findOne({
        where: { linkCode },
        transaction
      });

      if (!existingPack) {
        break;
      }

      linkCode = generateLinkCode();
      attempts++;
    }

    // If we still couldn't find a unique code, increase length
    if (attempts >= maxAttempts) {
      const extendedChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
      let extendedCode = '';
      for (let i = 0; i < 9; i++) {
        extendedCode += extendedChars.charAt(Math.floor(Math.random() * extendedChars.length));
      }
      linkCode = extendedCode;
    }

    const pack = await LevelPack.create({
      ownerId: queriedUser!.id,
      name: name.trim(),
      iconUrl: iconUrl || null,
      cssFlags: cssFlags || 0,
      viewMode: finalViewMode,
      isPinned: finalIsPinned,
      linkCode
    }, { transaction });

    await transaction.commit();

    return res.status(201).json({
      ...pack,
      id: pack.linkCode,
    });

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
    const resolvedPackId = await resolvePackId(req.params.id);
    if (!resolvedPackId) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'Invalid pack ID or link code' });
    }

    const pack = await LevelPack.findByPk(resolvedPackId, { transaction });
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

    // Only allow admins to modify pin status
    if (isPinned !== undefined) {
      if (!hasFlag(req.user, permissionFlags.SUPER_ADMIN)) {
        await safeTransactionRollback(transaction);
        return res.status(403).json({ error: 'Only administrators can modify pack pin status' });
      }
      updateData.isPinned = isPinned;
    }

    // Only restrict viewMode changes when involving public visibility
    if (viewMode !== undefined) {
      const isChangingToOrFromPublic = 
        viewMode === LevelPackViewModes.PUBLIC || 
        pack.viewMode === LevelPackViewModes.PUBLIC;
      
      if (isChangingToOrFromPublic && !hasFlag(req.user, permissionFlags.SUPER_ADMIN)) {
        await safeTransactionRollback(transaction);
        return res.status(403).json({ error: 'Only administrators can modify pack visibility to/from public' });
      }
      
      // Additional check for forced private packs
      if (pack.viewMode === LevelPackViewModes.FORCED_PRIVATE && !hasFlag(req.user, permissionFlags.SUPER_ADMIN)) {
        await safeTransactionRollback(transaction);
        return res.status(403).json({ error: 'Cannot modify view mode of admin-locked pack' });
      }
      
      updateData.viewMode = viewMode;
    }

    await pack.update(updateData, { transaction });
    await transaction.commit();

    return res.json({
      ...pack,
      id: pack.linkCode,
    });

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
    const resolvedPackId = await resolvePackId(req.params.id);
    if (!resolvedPackId) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'Invalid pack ID or link code' });
    }

    const pack = await LevelPack.findByPk(resolvedPackId, { transaction });
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
        const resolvedPackId = await resolvePackId(req.params.id);
        if (!resolvedPackId) {
            return res.status(400).json({ error: 'Invalid pack ID or link code' });
        }

        const pack = await LevelPack.findByPk(resolvedPackId);
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
        const resolvedPackId = await resolvePackId(req.params.id);
        if (!resolvedPackId) {
            return res.status(400).json({ error: 'Invalid pack ID or link code' });
        }

        const pack = await LevelPack.findByPk(resolvedPackId);
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
    const resolvedPackId = await resolvePackId(req.params.id);
    if (!resolvedPackId) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'Invalid pack ID or link code' });
    }

    const { type, name, levelIds, parentId, sortOrder } = req.body;

    if (!type || (type !== 'folder' && type !== 'level')) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'Type must be "folder" or "level"' });
    }

    const pack = await LevelPack.findByPk(resolvedPackId, { transaction });
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
          packId: resolvedPackId,
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
      let levelIdsToAdd: number[] = [];

      // Parse levelIds from string if provided
      if (levelIds && typeof levelIds === 'string') {
        // Extract all numbers from the string using regex
        const numberMatches = levelIds.match(/\d+/g);
        if (numberMatches) {
          levelIdsToAdd = numberMatches.map(match => parseInt(match)).filter(id => !isNaN(id));
        }
      }

      if (levelIdsToAdd.length === 0) {
        await safeTransactionRollback(transaction);
        return res.status(400).json({ error: 'Valid level ID(s) are required' });
      }

      // Validate all levels exist
      const levels = await Level.findAll({
        where: { id: { [Op.in]: levelIdsToAdd } },
        transaction
      });

      if (levels.length !== levelIdsToAdd.length) {
        await safeTransactionRollback(transaction);
        return res.status(404).json({ error: 'One or more levels not found' });
      }

      // Check which levels are already in pack
      const existingItems = await LevelPackItem.findAll({
        where: { 
          packId: resolvedPackId, 
          type: 'level', 
          levelId: { [Op.in]: levelIdsToAdd } 
        },
        transaction
      });

      const existingLevelIds = existingItems.map(item => item.levelId);
      const newLevelIds = levelIdsToAdd.filter(id => !existingLevelIds.includes(id));

      if (newLevelIds.length === 0) {
        await safeTransactionRollback(transaction);
        return res.status(400).json({ error: 'All specified levels are already in pack' });
      }

      // Check item limit
      const currentItemCount = await LevelPackItem.count({
        where: { packId: resolvedPackId },
        transaction
      });

      if (currentItemCount + newLevelIds.length > MAX_ITEMS_PER_PACK) {
        await safeTransactionRollback(transaction);
        return res.status(400).json({ 
          error: `Adding ${newLevelIds.length} items would exceed the maximum ${MAX_ITEMS_PER_PACK} items per pack`,
          details: { 
            currentCount: currentItemCount, 
            tryingToAdd: newLevelIds.length,
            maxAllowed: MAX_ITEMS_PER_PACK
          }
        });
      }

      // Add all new levels
      const createdItems = [];
      for (let i = 0; i < newLevelIds.length; i++) {
        const levelIdToAdd = newLevelIds[i];
        
        // Determine sort order for this item
        let finalSortOrder = sortOrder;
        if (finalSortOrder === undefined || finalSortOrder === null) {
          const maxSortOrder = await LevelPackItem.max('sortOrder', {
            where: { packId: resolvedPackId, parentId: parentId || null },
            transaction
          });
          finalSortOrder = (maxSortOrder as number || 0) + 1 + i;
        } else {
          finalSortOrder = finalSortOrder + i;
        }

        const item = await LevelPackItem.create({
          packId: resolvedPackId,
          type: 'level',
          parentId: parentId || null,
          name: null,
          levelId: levelIdToAdd,
          sortOrder: finalSortOrder
        }, { transaction });

        createdItems.push(item);
      }

      await transaction.commit();

      // Return all created items with level data
      const result = await LevelPackItem.findAll({
        where: { 
          id: { [Op.in]: createdItems.map(item => item.id) }
        },
        include: [{
          model: Level,
          as: 'referencedLevel'
        }]
      });

      return res.status(201).json(result);
    }

    // Handle folder creation (single folder)
    if (type === 'folder') {
      // Validate parent if provided
      if (parentId) {
        const parent = await LevelPackItem.findOne({
          where: { id: parentId, packId: resolvedPackId, type: 'folder' },
          transaction
        });

        if (!parent) {
          await safeTransactionRollback(transaction);
          return res.status(400).json({ error: 'Invalid parent folder' });
        }
      }

      // Check item limit
      const itemCount = await LevelPackItem.count({
        where: { packId: resolvedPackId },
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
          where: { packId: resolvedPackId, parentId: parentId || null },
          transaction
        });
        finalSortOrder = (maxSortOrder as number || 0) + 1;
      }

      const item = await LevelPackItem.create({
        packId: resolvedPackId,
        type: 'folder',
        parentId: parentId || null,
        name: name.trim(),
        levelId: null,
        sortOrder: finalSortOrder
      }, { transaction })

      await transaction.commit();

      return res.status(201).json(item);
    }

  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error adding item to pack:', error);
    return res.status(500).json({ error: 'Failed to add item to pack' });
  }
  return res.status(500).json({ error: 'Failed to add item to pack' });
});

// PUT /packs/:id/items/:itemId - Update item
router.put('/:id/items/:itemId', Auth.user(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();

  try {
    const resolvedPackId = await resolvePackId(req.params.id);
    if (!resolvedPackId) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'Invalid pack ID or link code' });
    }

    const itemId = parseInt(req.params.itemId);

    if (isNaN(itemId)) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'Invalid item ID' });
    }

    const pack = await LevelPack.findByPk(resolvedPackId, { transaction });
    if (!pack) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({ error: 'Pack not found' });
    }

    if (!canEditPack(pack, req.user)) {
      await safeTransactionRollback(transaction);
      return res.status(403).json({ error: 'Access denied' });
    }

    const item = await LevelPackItem.findOne({
      where: { id: itemId, packId: resolvedPackId },
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
          packId: resolvedPackId,
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

// PUT /packs/:id/tree - Update entire pack tree structure
router.put('/:id/tree', Auth.user(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();

  try {
    const resolvedPackId = await resolvePackId(req.params.id);
    if (!resolvedPackId) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'Invalid pack ID or link code' });
    }

    const { items } = req.body;

    if (!Array.isArray(items)) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'items must be an array' });
    }

    const pack = await LevelPack.findByPk(resolvedPackId, { transaction });
    if (!pack) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({ error: 'Pack not found' });
    }

    if (!canEditPack(pack, req.user)) {
      await safeTransactionRollback(transaction);
      return res.status(403).json({ error: 'Access denied' });
    }

    // Flatten the tree structure to get all updates
    const flattenTreeUpdates = (treeItems: any[], parentId: number | null = null, updates: any[] = []) => {
      treeItems.forEach((item, index) => {
        updates.push({
          id: item.id,
          parentId: parentId,
          sortOrder: index
        });
        
        if (item.children && Array.isArray(item.children)) {
          flattenTreeUpdates(item.children, item.id, updates);
        }
      });
      return updates;
    };

    const updates = flattenTreeUpdates(items);

    // Validate all items belong to this pack
    const itemIds = updates.map(u => u.id);
    const packItems = await LevelPackItem.findAll({
      where: {
        packId: resolvedPackId,
        id: { [Op.in]: itemIds }
      },
      transaction
    });

    if (packItems.length !== itemIds.length) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'Some items do not belong to this pack' });
    }

    // Check for circular references in folders
    const folderMap = new Map<number, number | null>();
    updates.forEach(update => {
      folderMap.set(update.id, update.parentId);
    });

    for (const item of packItems) {
      if (item.type === 'folder') {
        let currentParentId = folderMap.get(item.id);
        const visited = new Set<number>([item.id]);
        
        while (currentParentId) {
          if (visited.has(currentParentId)) {
            await safeTransactionRollback(transaction);
            return res.status(400).json({ error: 'Circular reference detected in folder structure' });
          }
          visited.add(currentParentId);
          currentParentId = folderMap.get(currentParentId);
        }
      }
    }

    // Perform all updates
    for (const update of updates) {
      await LevelPackItem.update(
        {
          parentId: update.parentId,
          sortOrder: update.sortOrder
        },
        {
          where: { id: update.id, packId: resolvedPackId },
          transaction
        }
      );
    }

    await transaction.commit();

    // Return the updated tree
    const updatedItems = await LevelPackItem.findAll({
      where: { packId: resolvedPackId },
      include: [{
        model: Level,
        as: 'referencedLevel',
        required: false
      }],
      order: [['sortOrder', 'ASC']]
    });

    // Convert Sequelize models to plain objects to avoid circular references
    const plainItems = updatedItems.map(item => item.toJSON());
    
    const updatedTree = buildItemTree(plainItems);

    return res.json({ items: updatedTree });

  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error updating pack tree:', error);
    return res.status(500).json({ error: 'Failed to update pack tree' });
  }
});

// ==================== PACK FAVORITES OPERATIONS ====================

// GET /packs/:id/favorite - Check if pack is favorited by current user
router.get('/:id/favorite', Auth.user(), async (req: Request, res: Response) => {
  try {
    const resolvedPackId = await resolvePackId(req.params.id);
    if (!resolvedPackId) {
      return res.status(400).json({ error: 'Invalid pack ID or link code' });
    }

    const favorite = await PackFavorite.findOne({
      where: {
        userId: req.user!.id,
        packId: resolvedPackId
      }
    });

    return res.json({ isFavorited: !!favorite });
  } catch (error) {
    logger.error('Error checking favorite status:', error);
    return res.status(500).json({ error: 'Failed to check favorite status' });
  }
});

// PUT /packs/:id/favorite - Set pack favorite status explicitly
router.put('/:id/favorite', Auth.user(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  if (!req.user) {
    await safeTransactionRollback(transaction);
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const resolvedPackId = await resolvePackId(req.params.id);
    if (!resolvedPackId) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'Invalid pack ID or link code' });
    }

    const { favorited } = req.body;

    if (typeof favorited !== 'boolean') {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'favorited must be a boolean value' });
    }

    // Check if pack exists
    const pack = await LevelPack.findByPk(resolvedPackId, { transaction });
    if (!pack) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({ error: 'Pack not found' });
    }

    // Check if pack is admin-locked
    if (pack.viewMode === 4) { // FORCED_PRIVATE
      await safeTransactionRollback(transaction);
      return res.status(403).json({ error: 'Cannot favorite admin-locked pack' });
    }

    // Check current favorite status
    const existingFavorite = await PackFavorite.findOne({
      where: { packId: resolvedPackId, userId: req.user?.id },
      transaction,
    });

    const currentlyFavorited = !!existingFavorite;

    // Only make changes if the desired state differs from current state
    if (favorited && !currentlyFavorited) {
      // Add favorite
      await PackFavorite.create({
        packId: resolvedPackId,
        userId: req.user?.id
      }, { transaction });
    } else if (!favorited && currentlyFavorited) {
      // Remove favorite
      await PackFavorite.destroy({
        where: { packId: resolvedPackId, userId: req.user?.id },
        transaction,
      });
    }

    await transaction.commit();

    // Get updated favorite count
    const favoriteCount = await PackFavorite.count({
      where: { packId: resolvedPackId },
    });

    return res.json({
      success: true,
      favorited: favorited,
      favorites: favoriteCount
    });
  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error setting pack favorite status:', error);
    return res.status(500).json({ error: 'Failed to set pack favorite status' });
  }
});

// GET /packs/favorites - Get user's favorited packs
router.get('/favorites', Auth.user(), async (req: Request, res: Response) => {
  try {
    const packs = await LevelPack.findAll({
      include: [
        {
          model: User,
          as: 'packOwner',
          attributes: ['id', 'nickname', 'username', 'avatarUrl']
        },
        {
          model: PackFavorite,
          as: 'favorites',
          where: { userId: req.user!.id },
          required: true
        }
      ],
      order: [['name', 'ASC']],
    }).then(packs => packs.map(pack => ({
      ...pack,
      id: pack.linkCode,
    })));

    return res.json({ packs });
  } catch (error) {
    logger.error('Error fetching favorited packs:', error);
    return res.status(500).json({ error: 'Failed to fetch favorited packs' });
  }
});

// DELETE /packs/:id/items/:itemId - Delete item
router.delete('/:id/items/:itemId', Auth.user(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();

  try {
    const resolvedPackId = await resolvePackId(req.params.id);
    if (!resolvedPackId) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'Invalid pack ID or link code' });
    }

    const itemId = parseInt(req.params.itemId);

    if (isNaN(itemId)) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'Invalid item ID' });
    }

    const pack = await LevelPack.findByPk(resolvedPackId, { transaction });
    if (!pack) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({ error: 'Pack not found' });
    }

    if (!canEditPack(pack, req.user)) {
      await safeTransactionRollback(transaction);
      return res.status(403).json({ error: 'Access denied' });
    }

    const item = await LevelPackItem.findOne({
      where: { id: itemId, packId: resolvedPackId },
      transaction
    });

    if (!item) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({ error: 'Item not found in pack' });
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
    const resolvedPackId = await resolvePackId(req.params.id);
    if (!resolvedPackId) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'Invalid pack ID or link code' });
    }

    const { items } = req.body;

    if (!Array.isArray(items)) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'items must be an array' });
    }

    const pack = await LevelPack.findByPk(resolvedPackId, { transaction });
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
            where: { id, packId: resolvedPackId },
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