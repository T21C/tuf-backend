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

const router: Router = Router();

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

    // Phase 1: Fetch all matching pack IDs with isPinned flag, sorted with pins first
    const allPackIds: { id: number, isPinned: boolean }[] = [];
    let totalCount = 0;

    // Only fetch pinned pack IDs if not specifically filtering for non-pinned
    if (parsedPinned !== 'false') {
      const pinnedResult = await LevelPack.findAndCountAll({
        where: pinnedWhereConditions,
        attributes: ['id', 'isPinned'],
        include: includeLevels ? [{
          model: LevelPackItem,
          as: 'packItems',
          where: parsedLevelId ? { levelId: parseInt(parsedLevelId) } : undefined,
          required: parsedLevelId ? true : false,
          attributes: [] // Only need for filtering, not data
        }] : [],
        order: [[sort as string, order as string]],
        distinct: true
      });
      
      allPackIds.push(...pinnedResult.rows.map(pack => ({ id: pack.id, isPinned: pack.isPinned })));
      totalCount += pinnedResult.count;
    }

    // Fetch regular pack IDs
    const regularResult = await LevelPack.findAndCountAll({
      where: whereConditions,
      attributes: ['id', 'isPinned'],
      include: includeLevels ? [{
        model: LevelPackItem,
        as: 'packItems',
        where: levelId ? { levelId: parseInt(levelId as string) } : undefined,
        required: levelId ? true : false,
        attributes: [] // Only need for filtering, not data
      },
    {
      model: User,
      as: 'packOwner',
      attributes: ['id', 'nickname', 'username', 'avatarUrl']
    }] : [],
      order: [[sort as string, order as string]],
      distinct: true
    });
    
    allPackIds.push(...regularResult.rows.map(pack => ({ id: pack.id, isPinned: pack.isPinned })));
    totalCount += regularResult.count;

    // Apply pagination to the combined pack IDs
    const paginatedPackIds = allPackIds.slice(parsedOffset, parsedOffset + parsedLimit);

    // Phase 2: Fetch full pack objects for the paginated IDs
    let fullPacks: any[] = [];
    if (paginatedPackIds.length > 0) {
      const packIds = paginatedPackIds.map(p => p.id);
      
      fullPacks = await LevelPack.findAll({
        where: { id: { [Op.in]: packIds } },
        include: includeLevels ? [{
          model: LevelPackItem,
          as: 'packItems',
          where: levelId ? { levelId: parseInt(levelId as string) } : undefined,
          required: levelId ? true : false,
          include: [{
            model: Level,
            as: 'level',
            attributes: ['id', 'song', 'artist', 'creator', 'diffId']
          }]
        },
        {
          model: User,
          as: 'packOwner',
          attributes: ['id', 'nickname', 'username', 'avatarUrl']
        }] : [
          {
            model: LevelPackItem,
            as: 'packItems',
            include: [{
              model: Level,
              as: 'level',
              attributes: ['id', 'song', 'artist', 'creator', 'diffId']
            }]
          },
          {
            model: User,
            as: 'packOwner',
            attributes: ['id', 'nickname', 'username', 'avatarUrl']
          }
        ],
        order: [
          // Maintain the original sort order within the paginated results
          [sort as string, order as string]
        ]
      });

      // Sort the full packs to match the paginated order (pins first, then by original sort)
      const packOrderMap = new Map(paginatedPackIds.map((p, index) => [p.id, index]));
      fullPacks.sort((a, b) => {
        const aIndex = packOrderMap.get(a.id) ?? 0;
        const bIndex = packOrderMap.get(b.id) ?? 0;
        return aIndex - bIndex;
      });
    }

    // Filter packs based on user permissions
    const filteredPacks = fullPacks.filter(pack => canViewPack(pack, userReq));

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
          attributes: ['id', 'song', 'artist', 'creator', 'charter', 'vfxer', 'team', 'diffId', 'baseScore', 'clears', 'likes', 'videoLink', 'dlLink', 'workshopLink']
        }],
        order: [['sortOrder', 'ASC']]
      },
      {
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

    return res.json(pack);

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

export default router;

