import { Router, Request, Response } from 'express';
import { Auth } from '../../../middleware/auth.js';
import { LevelPack, LevelPackItem, PackFolder, LevelPackViewModes, LevelPackCSSFlags } from '../../../models/packs/index.js';
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
const MAX_PACKS_PER_USER = 20;
const MAX_LEVELS_PER_PACK = 500;
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
      return true; // Link-only means visible but not searchable
    case LevelPackViewModes.PRIVATE:
      return false;
    case LevelPackViewModes.FORCED_PRIVATE:
      return false; // Admin override
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

// GET /packs - List packs with search functionality
router.get('/', Auth.addUserToRequest(), async (req: Request, res: Response) => {
  try {
    const {
      query,
      ownerUsername,
      levelId,
      viewMode,
      pinned,
      offset = 0,
      limit = DEFAULT_LIMIT,
      sort = 'createdAt',
      order = 'DESC'
    } = req.query;

    const parsedLimit = Math.min(parseInt(limit as string) || DEFAULT_LIMIT, MAX_LIMIT);
    const parsedOffset = parseInt(offset as string) || 0;

    // Parse the query for special field patterns
    let parsedQuery = query as string;
    let parsedOwnerUsername = ownerUsername as string;
    let parsedLevelId = levelId as string;
    let parsedViewMode = viewMode as string;
    let parsedPinned = pinned as string;

    // If query contains special patterns, parse them and extract values
    if (query) {
      const searchGroups = parseSearchQuery(query as string, queryParserConfigs.pack);
      
      // Extract special field values using utility functions
      const ownerUsernames = extractFieldValues(searchGroups, 'ownerusername');
      const levelIds = extractFieldValues(searchGroups, 'levelid');
      const viewModes = extractFieldValues(searchGroups, 'viewmode');
      const pinnedValues = extractFieldValues(searchGroups, 'pinned');
      
      // Use the first value found for each field
      if (ownerUsernames.length > 0) parsedOwnerUsername = ownerUsernames[0];
      if (levelIds.length > 0) parsedLevelId = levelIds[0];
      if (viewModes.length > 0) parsedViewMode = viewModes[0];
      if (pinnedValues.length > 0) parsedPinned = pinnedValues[0];
    }

    const userReq = parsedOwnerUsername ? await User.findOne({
      where: {
        username: parsedOwnerUsername
      }
    }) : null;

    // Build where conditions for regular packs
    const whereConditions: any = {};

    // Handle parsed special fields
    if (userReq) {    
      whereConditions.ownerId = userReq.id;
    }

    if (parsedViewMode !== undefined) {
      const viewModeValue = parseInt(parsedViewMode);
      if (!isNaN(viewModeValue)) {
        whereConditions.viewMode = viewModeValue;
      }
    }

    if (parsedPinned !== undefined) {
      if (parsedPinned === 'true') {
        whereConditions.isPinned = true;
      } else if (parsedPinned === 'false') {
        whereConditions.isPinned = false;
      }
    }

    // Handle name search from query
    if (query) {
      const searchGroups = parseSearchQuery(query as string, queryParserConfigs.pack);
      
      // Extract name search terms using utility functions
      const nameSearchTerms = extractFieldValues(searchGroups, 'name');
      const generalSearchTerms = extractGeneralSearchTerms(searchGroups);
      const allSearchTerms = [...nameSearchTerms, ...generalSearchTerms];
      
      // If we have name search terms, add them to where conditions
      if (allSearchTerms.length > 0) {
        const nameConditions = allSearchTerms.map(term => ({
          name: {
            [Op.like]: `%${term}%`
          }
        }));
        
        if (nameConditions.length === 1) {
          whereConditions.name = nameConditions[0].name;
        } else {
          whereConditions[Op.or] = nameConditions;
        }
      }
    }

    // Filter by view mode for non-owners (only if not already set by query parsing)
    if (!whereConditions.viewMode && (!req.user || (userReq && whereConditions.ownerId !== userReq.id))) {
      whereConditions.viewMode = {
        [Op.in]: [LevelPackViewModes.PUBLIC, LevelPackViewModes.LINKONLY]
      }
    }

    // Build where conditions for pinned packs (admin-curated important packs)
    const pinnedWhereConditions: any = {
      isPinned: true
    };

    // Pinned packs should match search queries but ignore other filters
    if (query) {
      const searchGroups = parseSearchQuery(query as string, queryParserConfigs.pack);
      
      // Extract name search terms for pinned packs using utility functions
      const nameSearchTerms = extractFieldValues(searchGroups, 'name');
      const generalSearchTerms = extractGeneralSearchTerms(searchGroups);
      const allSearchTerms = [...nameSearchTerms, ...generalSearchTerms];
      
      // If we have name search terms, add them to pinned where conditions
      if (allSearchTerms.length > 0) {
        const nameConditions = allSearchTerms.map(term => ({
          name: {
            [Op.like]: `%${term}%`
          }
        }));
        
        if (nameConditions.length === 1) {
          pinnedWhereConditions.name = nameConditions[0].name;
        } else {
          pinnedWhereConditions[Op.or] = nameConditions;
        }
      }
    }

    // Pinned packs are always visible (admin-curated)
    // No view mode restrictions for pinned packs

    // If searching by level ID, we need to join with LevelPackItem
    let includeLevels = false;
    if (parsedLevelId) {
      includeLevels = true;
    }

    // Fetch all matching packs first
    const allPacks: any[] = [];
    let totalCount = 0;

    // Fetch regular packs
    const result = await LevelPack.findAndCountAll({
      where: whereConditions,
      include: includeLevels ? [{
        model: LevelPackItem,
        as: 'packItems',
        where: levelId ? { levelId: parseInt(levelId as string) } : undefined,
        required: levelId ? true : false,
        include: [{
          model: Level,
          as: 'level',
          attributes: ['id', 'song', 'artist', 'creator', 'charter', 'vfxer', 'team', 'diffId']
        }]
      },
      {
        model: User,
        as: 'packOwner',
        attributes: ['id', 'nickname', 'username', 'avatarUrl']
      },
      {
        model: PackFolder,
        as: 'folder',
        attributes: ['id', 'name', 'parentFolderId']
      }] : [
        {
          model: LevelPackItem,
          as: 'packItems',
          include: [{
            model: Level,
            as: 'level',
            attributes: ['id', 'song', 'artist', 'creator', 'charter', 'vfxer', 'team', 'diffId']
          }]
        },
        {
          model: User,
          as: 'packOwner',
          attributes: ['id', 'nickname', 'username', 'avatarUrl']
        },
        {
          model: PackFolder,
          as: 'folder',
          attributes: ['id', 'name', 'parentFolderId']
        }
      ],
      order: [[sort as string, order as string]],
      distinct: true
    });
    
    allPacks.push(...result.rows);
    totalCount += result.count;

    // Sort all packs to have pinned first, then by the original sort order
    allPacks.sort((a, b) => {
      // Pinned packs come first
      if (a.isPinned && !b.isPinned) return -1;
      if (!a.isPinned && b.isPinned) return 1;
      
      // If both are pinned or both are not pinned, maintain original sort order
      const sortField = sort as string;
      const sortOrder = order as string;
      
      let aValue = a[sortField];
      let bValue = b[sortField];
      
      // Handle date fields
      if (sortField === 'createdAt' || sortField === 'updatedAt') {
        aValue = new Date(aValue).getTime();
        bValue = new Date(bValue).getTime();
      }
      
      // Handle string fields
      if (typeof aValue === 'string' && typeof bValue === 'string') {
        aValue = aValue.toLowerCase();
        bValue = bValue.toLowerCase();
      }
      
      if (sortOrder === 'ASC') {
        return aValue < bValue ? -1 : aValue > bValue ? 1 : 0;
      } else {
        return aValue > bValue ? -1 : aValue < bValue ? 1 : 0;
      }
    });

    // Apply pagination to the sorted packs
    const paginatedPacks = allPacks.slice(parsedOffset, parsedOffset + parsedLimit);

    // Filter packs based on user permissions
    const filteredPacks = paginatedPacks.filter(pack => canViewPack(pack, userReq));

    return res.json({
      packs: filteredPacks,
      total: totalCount,
      offset: parsedOffset,
      limit: parsedLimit
    });

  } catch (error) {
    logger.error('Error fetching packs:', error);
    return res.status(500).json({ error: 'Failed to fetch packs' });
  }
});

// GET /packs/:id - Get specific pack with levels
router.get('/:id', Auth.addUserToRequest(), async (req: Request, res: Response) => {
  try {
    const packId = parseInt(req.params.id);
    if (isNaN(packId)) {
      return res.status(400).json({ error: 'Invalid pack ID' });
    }

    const pack = await LevelPack.findByPk(packId, {
      include: [{
        model: LevelPackItem,
        as: 'packItems',
        include: [{
          model: Level,
          as: 'level',
        }],
        order: [['sortOrder', 'ASC']]
      },
      {
        model: User,
        as: 'packOwner',
        attributes: ['id', 'nickname', 'username', 'avatarUrl']
      },
      {
        model: PackFolder,
        as: 'folder',
        attributes: ['id', 'name', 'parentFolderId']
      }]
    });

    if (!pack) {
      return res.status(404).json({ error: 'Pack not found' });
    }

    // Get all folders for the pack owner
    const folders = await PackFolder.findAll({
      where: {
        ownerId: pack.ownerId
      },
      include: [
        {
          model: LevelPack,
          as: 'packs',
          attributes: ['id', 'name', 'iconUrl', 'isPinned', 'viewMode'],
          order: [['sortOrder', 'ASC']]
        }
      ],
      order: [['sortOrder', 'ASC']]
    });

    if (!canViewPack(pack, req.user)) {
        return res.status(403).json({ error: 'Access denied' });
    }

    // Include folders in the response
    const packWithFolders = {
      ...pack.toJSON(),
      folders: folders
    };

    return res.json(packWithFolders);

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

    const pack = await LevelPack.findByPk(packId, {
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
                as: 'level',
                attributes: ['id', 'song', 'artist', 'creator', 'charter', 'vfxer', 'team', 'diffId']
            }]
        }],
        transaction
    });
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

// POST /packs/:id/levels - Add level to pack
router.post('/:id/levels', Auth.user(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  
  try {
    const packId = parseInt(req.params.id);
    const { levelId, sortOrder } = req.body;

    if (isNaN(packId)) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'Invalid pack ID' });
    }

    if (!levelId || isNaN(parseInt(levelId))) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'Valid level ID is required' });
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

    // Check if level exists
    const level = await Level.findByPk(parseInt(levelId), { transaction });
    if (!level) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({ error: 'Level not found' });
    }

    // Check if level is already in pack
    const existingItem = await LevelPackItem.findOne({
      where: { packId, levelId: parseInt(levelId) },
      transaction
    });

    if (existingItem) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'Level already in pack' });
    }

    // Check pack level limit
    const levelCount = await LevelPackItem.count({
      where: { packId },
      transaction
    });

    if (levelCount >= MAX_LEVELS_PER_PACK) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: `Maximum ${MAX_LEVELS_PER_PACK} levels allowed per pack` });
    }

    // Determine sort order
    let finalSortOrder = sortOrder;
    if (finalSortOrder === undefined || finalSortOrder === null) {
      const maxSortOrder = await LevelPackItem.max('sortOrder', {
        where: { packId },
        transaction
      });
      finalSortOrder = (maxSortOrder as number || 0) + 1;
    }

    const packItem = await LevelPackItem.create({
      packId,
      levelId: parseInt(levelId),
      sortOrder: finalSortOrder
    }, { transaction });

    await transaction.commit();

    // Return the pack item with level data
    const result = await LevelPackItem.findByPk(packItem.id, {
      include: [{
        model: Level,
        as: 'level',
        attributes: ['id', 'song', 'artist', 'creator', 'charter', 'vfxer', 'team', 'diffId']
      }]
    });

    return res.status(201).json(result);

  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error adding level to pack:', error);
    return res.status(500).json({ error: 'Failed to add level to pack' });
  }
});

// DELETE /packs/:id/levels/:levelId - Remove level from pack
router.delete('/:id/levels/:levelId', Auth.user(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  
  try {
    const packId = parseInt(req.params.id);
    const levelId = parseInt(req.params.levelId);

    if (isNaN(packId) || isNaN(levelId)) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'Invalid pack ID or level ID' });
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

    const packItem = await LevelPackItem.findOne({
      where: { packId, levelId },
      transaction
    });

    if (!packItem) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({ error: 'Level not found in pack' });
    }

    await packItem.destroy({ transaction });
    await transaction.commit();

    return res.status(204).end();

  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error removing level from pack:', error);
    return res.status(500).json({ error: 'Failed to remove level from pack' });
  }
});

// PUT /packs/:id/levels/reorder - Reorder levels in pack
router.put('/:id/levels/reorder', Auth.user(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  
  try {
    const packId = parseInt(req.params.id);
    const { levelOrders } = req.body; // Array of { levelId, sortOrder }

    if (isNaN(packId)) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'Invalid pack ID' });
    }

    if (!Array.isArray(levelOrders)) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'levelOrders must be an array' });
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

    // Update sort orders
    for (const { levelId, sortOrder } of levelOrders) {
      if (levelId && sortOrder !== undefined) {
        await LevelPackItem.update(
          { sortOrder },
          {
            where: { packId, levelId },
            transaction
          }
        );
      }
    }

    await transaction.commit();

    return res.json({ success: true });

  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error reordering pack levels:', error);
    return res.status(500).json({ error: 'Failed to reorder pack levels' });
  }
});

// GET /packs/user/:ownerUsername - Get packs by specific user
router.get('/user/:ownerUsername', Auth.addUserToRequest(), async (req: Request, res: Response) => {
  try {
    const { ownerUsername } = req.params;
    const { viewMode, offset = 0, limit = DEFAULT_LIMIT } = req.query;

    const parsedLimit = Math.min(parseInt(limit as string) || DEFAULT_LIMIT, MAX_LIMIT);
    const parsedOffset = parseInt(offset as string) || 0;

    const whereConditions: any = { ownerUsername };

    // If not the owner and not admin, only show public/linkonly packs
    if (!req.user || req.user.username !== ownerUsername) {
      if (!hasFlag(req.user, permissionFlags.SUPER_ADMIN)) {
        whereConditions.viewMode = {
          [Op.in]: [LevelPackViewModes.PUBLIC, LevelPackViewModes.LINKONLY]
        };
      }
    }

    if (viewMode !== undefined) {
      whereConditions.viewMode = parseInt(viewMode as string);
    }

    const packs = await LevelPack.findAndCountAll({
      where: whereConditions,
      limit: parsedLimit,
      offset: parsedOffset,
      order: [['createdAt', 'DESC']]
    });

    return res.json({
      packs: packs.rows,
      total: packs.count,
      offset: parsedOffset,
      limit: parsedLimit
    });

  } catch (error) {
    logger.error('Error fetching user packs:', error);
    return res.status(500).json({ error: 'Failed to fetch user packs' });
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

        // Upload to CDN
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

        // Update pack's icon information
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

        // Extract file ID from URL before clearing it
        const oldFileId = getFileIdFromCdnUrl(pack.iconUrl);

        // Update pack's icon information first
        await pack.update({
            iconUrl: null
        });

        // Delete from CDN after updating pack record
        try {
            if (oldFileId) {
                await cdnService.deleteFile(oldFileId);
            }
        } catch (error) {
            // Log the error but don't fail the request since pack record is already updated
            logger.error('Error deleting old pack icon from CDN:', error);
        }

        return res.json({ message: 'Pack icon removed successfully' });
    } catch (error) {
        logger.error('Error removing pack icon:', error);
        return res.status(500).json({ error: 'Failed to remove pack icon' });
    }
});

// ==================== FOLDER MANAGEMENT ENDPOINTS ====================

// Helper function to check if user can manage folder
const canManageFolder = (folder: PackFolder, user: any): boolean => {
  if (!user || !folder) return false;
  
  // Owner can manage their own folders
  if (folder.ownerId === user.id) return true;
  
  // Admin can manage all folders
  return hasFlag(user, permissionFlags.SUPER_ADMIN);
};

// Helper function to get folder hierarchy path
const getFolderPath = async (folderId: number): Promise<string[]> => {
  const path: string[] = [];
  let currentFolderId = folderId;
  
  while (currentFolderId) {
    const folder = await PackFolder.findByPk(currentFolderId);
    if (!folder) break;
    
    path.unshift(folder.name);
    currentFolderId = folder.parentFolderId || 0;
  }
  
  return path;
};

// GET /packs/folders - Get all folders for a user
router.get('/folders', Auth.user(), async (req: Request, res: Response) => {
  try {
    const { parentFolderId } = req.query;
    
    const whereConditions: any = {
      ownerId: req.user!.id
    };
    
    if (parentFolderId !== undefined) {
      whereConditions.parentFolderId = parentFolderId === 'null' ? null : parseInt(parentFolderId as string);
    }
    
    const folders = await PackFolder.findAll({
      where: whereConditions,
      include: [
        {
          model: PackFolder,
          as: 'subFolders',
          include: [
            {
              model: LevelPack,
              as: 'packs',
              attributes: ['id', 'name', 'iconUrl', 'isPinned', 'viewMode'],
              order: [['sortOrder', 'ASC']]
            }
          ]
        },
        {
          model: LevelPack,
          as: 'packs',
          attributes: ['id', 'name', 'iconUrl', 'isPinned', 'viewMode'],
          order: [['sortOrder', 'ASC']]
        }
      ],
      order: [['sortOrder', 'ASC']]
    });
    
    // Add path information to each folder
    const foldersWithPaths = await Promise.all(
      folders.map(async (folder) => {
        const path = await getFolderPath(folder.id);
        return {
          ...folder.toJSON(),
          path: path.join(' > ')
        };
      })
    );
    
    return res.json({ folders: foldersWithPaths });
    
  } catch (error) {
    logger.error('Error fetching folders:', error);
    return res.status(500).json({ error: 'Failed to fetch folders' });
  }
});


// POST /packs/folders - Create new folder
router.post('/folders', Auth.user(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  
  try {
    const { name, parentFolderId } = req.body;
    
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'Folder name is required' });
    }
    
    // Check if parent folder exists and belongs to user
    if (parentFolderId) {
      const parentFolder = await PackFolder.findByPk(parentFolderId, { transaction });
      if (!parentFolder || parentFolder.ownerId !== req.user!.id) {
        await safeTransactionRollback(transaction);
        return res.status(400).json({ error: 'Invalid parent folder' });
      }
    }
    
    // Check for duplicate folder name in same parent
    const existingFolder = await PackFolder.findOne({
      where: {
        ownerId: req.user!.id,
        parentFolderId: parentFolderId || null,
        name: name.trim()
      },
      transaction
    });
    
    if (existingFolder) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'Folder with this name already exists in this location' });
    }
    
    // Get next sort order
    const maxSortOrder = await PackFolder.max('sortOrder', {
      where: {
        ownerId: req.user!.id,
        parentFolderId: parentFolderId || null
      },
      transaction
    });
    
    const folder = await PackFolder.create({
      ownerId: req.user!.id,
      name: name.trim(),
      parentFolderId: parentFolderId || null,
      sortOrder: (maxSortOrder as number || 0) + 1
    }, { transaction });
    
    await transaction.commit();
    
    return res.status(201).json(folder);
    
  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error creating folder:', error);
    return res.status(500).json({ error: 'Failed to create folder' });
  }
});

// PUT /packs/folders/:id - Update folder
router.put('/folders/:id', Auth.user(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  
  try {
    const folderId = parseInt(req.params.id);
    if (isNaN(folderId)) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'Invalid folder ID' });
    }
    
    const folder = await PackFolder.findByPk(folderId, { transaction });
    if (!folder) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({ error: 'Folder not found' });
    }
    
    if (!canManageFolder(folder, req.user)) {
      await safeTransactionRollback(transaction);
      return res.status(403).json({ error: 'Access denied' });
    }
    
    const { name, parentFolderId, isExpanded } = req.body;
    const updateData: any = {};
    
    if (name !== undefined) {
      if (typeof name !== 'string' || name.trim().length === 0) {
        await safeTransactionRollback(transaction);
        return res.status(400).json({ error: 'Folder name cannot be empty' });
      }
      
      // Check for duplicate folder name in same parent
      const existingFolder = await PackFolder.findOne({
        where: {
          ownerId: req.user!.id,
          parentFolderId: folder.parentFolderId,
          name: name.trim(),
          id: { [Op.ne]: folderId }
        },
        transaction
      });
      
      if (existingFolder) {
        await safeTransactionRollback(transaction);
        return res.status(400).json({ error: 'Folder with this name already exists in this location' });
      }
      
      updateData.name = name.trim();
    }
    
    if (parentFolderId !== undefined) {
      // Prevent moving folder into itself or its subfolders
      if (parentFolderId === folderId) {
        await safeTransactionRollback(transaction);
        return res.status(400).json({ error: 'Cannot move folder into itself' });
      }
      
      // Check if new parent folder exists and belongs to user
      if (parentFolderId) {
        const newParentFolder = await PackFolder.findByPk(parentFolderId, { transaction });
        if (!newParentFolder || newParentFolder.ownerId !== req.user!.id) {
          await safeTransactionRollback(transaction);
          return res.status(400).json({ error: 'Invalid parent folder' });
        }
        
        // Check for circular reference
        let currentParentId = newParentFolder.parentFolderId;
        while (currentParentId) {
          if (currentParentId === folderId) {
            await safeTransactionRollback(transaction);
            return res.status(400).json({ error: 'Cannot move folder into its own subfolder' });
          }
          const parentFolder = await PackFolder.findByPk(currentParentId, { transaction });
          currentParentId = parentFolder?.parentFolderId || null;
        }
      }
      
      updateData.parentFolderId = parentFolderId;
      
      // Get new sort order in new parent
      const maxSortOrder = await PackFolder.max('sortOrder', {
        where: {
          ownerId: req.user!.id,
          parentFolderId: parentFolderId || null
        },
        transaction
      });
      updateData.sortOrder = (maxSortOrder as number || 0) + 1;
    }
    
    if (isExpanded !== undefined) {
      updateData.isExpanded = isExpanded;
    }
    
    await folder.update(updateData, { transaction });
    await transaction.commit();
    
    return res.json(folder);
    
  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error updating folder:', error);
    return res.status(500).json({ error: 'Failed to update folder' });
  }
});

// DELETE /packs/folders/:id - Delete folder
router.delete('/folders/:id', Auth.user(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  
  try {
    const folderId = parseInt(req.params.id);
    if (isNaN(folderId)) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'Invalid folder ID' });
    }
    
    const folder = await PackFolder.findByPk(folderId, { transaction });
    if (!folder) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({ error: 'Folder not found' });
    }
    
    if (!canManageFolder(folder, req.user)) {
      await safeTransactionRollback(transaction);
      return res.status(403).json({ error: 'Access denied' });
    }
    
    // Check if folder has subfolders or packs
    const subFolderCount = await PackFolder.count({
      where: { parentFolderId: folderId },
      transaction
    });
    
    const packCount = await LevelPack.count({
      where: { folderId: folderId },
      transaction
    });
    
    if (subFolderCount > 0 || packCount > 0) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ 
        error: 'Cannot delete folder that contains items',
        details: { subFolders: subFolderCount, packs: packCount }
      });
    }
    
    await folder.destroy({ transaction });
    await transaction.commit();
    
    return res.status(204).end();
    
  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error deleting folder:', error);
    return res.status(500).json({ error: 'Failed to delete folder' });
  }
});

// PUT /packs/folders/reorder - Reorder folders and packs
router.put('/folders/reorder', Auth.user(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  
  try {
    const { folders, packs } = req.body;
    
    if (!Array.isArray(folders) || !Array.isArray(packs)) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'folders and packs must be arrays' });
    }
    
    // Update folder sort orders
    for (const { id, sortOrder } of folders) {
      if (id && sortOrder !== undefined) {
        await PackFolder.update(
          { sortOrder },
          {
            where: { 
              id,
              ownerId: req.user!.id // Ensure user owns the folder
            },
            transaction
          }
        );
      }
    }
    
    // Update pack sort orders
    for (const { id, sortOrder, folderId } of packs) {
      if (id && sortOrder !== undefined) {
        await LevelPack.update(
          { sortOrder, folderId: folderId || null },
          {
            where: { 
              id,
              ownerId: req.user!.id // Ensure user owns the pack
            },
            transaction
          }
        );
      }
    }
    
    await transaction.commit();
    
    return res.json({ success: true });
    
  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error reordering folders and packs:', error);
    return res.status(500).json({ error: 'Failed to reorder items' });
  }
});

// PUT /packs/folders/:folderId/packs/:levelId - Move level to folder
router.put('/folders/:folderId/packs/:levelId', Auth.user(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  
  try {
    const folderId = parseInt(req.params.folderId);
    const levelId = parseInt(req.params.levelId);
    
    if (isNaN(folderId) || isNaN(levelId)) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'Invalid folder ID or level ID' });
    }
    
    // Check if folder exists and belongs to user
    const folder = await PackFolder.findByPk(folderId, { transaction });
    if (!folder || folder.ownerId !== req.user!.id) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({ error: 'Folder not found' });
    }
    
    // Check if level exists
    const level = await Level.findByPk(levelId, { transaction });
    if (!level) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({ error: 'Level not found' });
    }
    
    // Find the pack item that contains this level
    const packItem = await LevelPackItem.findOne({
      where: { levelId },
      include: [{
        model: LevelPack,
        as: 'pack',
        where: { ownerId: req.user!.id }
      }],
      transaction
    });
    
    if (!packItem) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({ error: 'Level not found in your packs' });
    }
    
    // Update the pack to be in the folder
    await LevelPack.update(
      { folderId },
      {
        where: { id: packItem.packId },
        transaction
      }
    );
    
    await transaction.commit();
    
    return res.json({ success: true });
    
  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error moving level to folder:', error);
    return res.status(500).json({ error: 'Failed to move level to folder' });
  }
});

// PUT /packs/folders/:folderId/folders/:sourceFolderId - Move folder to another folder
router.put('/folders/:folderId/folders/:sourceFolderId', Auth.user(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  
  try {
    const targetFolderId = parseInt(req.params.folderId);
    const sourceFolderId = parseInt(req.params.sourceFolderId);
    
    if (isNaN(targetFolderId) || isNaN(sourceFolderId)) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'Invalid folder ID' });
    }
    
    // Check if target folder exists and belongs to user
    const targetFolder = await PackFolder.findByPk(targetFolderId, { transaction });
    if (!targetFolder || targetFolder.ownerId !== req.user!.id) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({ error: 'Target folder not found' });
    }
    
    // Check if source folder exists and belongs to user
    const sourceFolder = await PackFolder.findByPk(sourceFolderId, { transaction });
    if (!sourceFolder || sourceFolder.ownerId !== req.user!.id) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({ error: 'Source folder not found' });
    }
    
    // Prevent moving folder into itself or its subfolders
    if (targetFolderId === sourceFolderId) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'Cannot move folder into itself' });
    }
    
    // Check for circular reference
    let currentParentId = targetFolder.parentFolderId;
    while (currentParentId) {
      if (currentParentId === sourceFolderId) {
        await safeTransactionRollback(transaction);
        return res.status(400).json({ error: 'Cannot move folder into its own subfolder' });
      }
      const parentFolder = await PackFolder.findByPk(currentParentId, { transaction });
      currentParentId = parentFolder?.parentFolderId || null;
    }
    
    // Update source folder's parent
    await PackFolder.update(
      { parentFolderId: targetFolderId },
      {
        where: { id: sourceFolderId },
        transaction
      }
    );
    
    await transaction.commit();
    
    return res.json({ success: true });
    
  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error moving folder to folder:', error);
    return res.status(500).json({ error: 'Failed to move folder to folder' });
  }
});

export default router;

