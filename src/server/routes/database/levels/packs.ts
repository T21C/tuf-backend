import { Router, Request, Response } from 'express';
import { createHash } from 'crypto';
import { Auth } from '../../../middleware/auth.js';
import { LevelPack, LevelPackItem, PackFavorite, LevelPackViewModes } from '../../../../models/packs/index.js';
import Level from '../../../../models/levels/Level.js';
import { User } from '../../../../models/index.js';
import { Op, QueryTypes } from 'sequelize';
import sequelize from '../../../../config/db.js';
import { logger } from '../../../services/LoggerService.js';
import { hasFlag } from '../../../../misc/utils/auth/permissionUtils.js';
import { permissionFlags } from '../../../../config/constants.js';
import { safeTransactionRollback } from '../../../../misc/utils/Utility.js';
import { parseSearchQuery,  queryParserConfigs, type SearchGroup } from '../../../../misc/utils/data/queryParser.js';
import { getFileIdFromCdnUrl, isCdnUrl } from '../../../../misc/utils/Utility.js';
import multer from 'multer';
import cdnService from '../../../services/CdnService.js';
import { CdnError } from '../../../services/CdnService.js';
import Pass from '../../../../models/passes/Pass.js';
import Curation from '../../../../models/curations/Curation.js';
import CurationType from '../../../../models/curations/CurationType.js';
import LevelCredit from '../../../../models/levels/LevelCredit.js';
import LevelTag from '../../../../models/levels/LevelTag.js';
import Creator from '../../../../models/credits/Creator.js';
import Team from '../../../../models/credits/Team.js';

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
  console.log('Pack view mode:', pack.viewMode);
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

  // CRITICAL: Sort by sortOrder ONLY - no other sorting criteria
  children.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));

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
const resolvePackId = async (param: string, transaction?: any): Promise<number | null> => {
  if (/^[A-Za-z0-9]+$/.test(param)) {
    const pack = await LevelPack.findOne({
      where: { linkCode: param },
      transaction
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

      // Always add the result set, even if empty (for proper AND logic)
      groupPackIdSets.push(new Set(packIds));
    }

    // Combine terms within group using intersection (AND logic)
    // If any term returns no results, the entire group should be empty
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

const sortableFields = {
  'RECENT': 'createdAt',
  'NAME': 'name',
  'FAVORITES': 'favoritesCount',
  'LEVELS': 'levelCount'
};
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
      sort = 'RECENT',
      order: orderQuery = 'DESC'
    } = req.query;

    const parsedLimit = Math.min(parseInt(limit as string) || DEFAULT_LIMIT, MAX_LIMIT);
    const parsedOffset = parseInt(offset as string) || 0;

    const whereConditions: any = {};

    const sortField = sortableFields[sort as keyof typeof sortableFields] || 'createdAt';
    const order = (orderQuery !== 'ASC' && orderQuery !== 'DESC') ? 'DESC' : orderQuery;

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

    if (searchPackIds && searchPackIds.size > 0) {
      whereConditions.id = { [Op.in]: Array.from(searchPackIds) };
    }
    // First, get all pack IDs with sorting applied (isPinned first, then requested sort)
    const sortedPacks = await LevelPack.findAll({
      where: whereConditions,
      attributes: ['id', 'isPinned', sortField, 'viewMode'],
      order: [
        ['isPinned', 'DESC'], // Pinned packs first
        [sortField, order] // Then by requested sort
      ]
    });
    // Apply view mode filtering to get valid pack IDs
    const viewModeFilter = (pack: LevelPack) : boolean => {
      if (hasFlag(req.user, permissionFlags.SUPER_ADMIN)) return true;
      if (ownPackIds.has(pack.id)) return true;
      if (pack.viewMode === LevelPackViewModes.PUBLIC) return true;
      return false;
    };

    const validPackIds = sortedPacks
      .filter(viewModeFilter)
      .map(pack => pack.id);

    // Step 5: Apply pagination to the sorted ID list
    const totalCount = validPackIds.length;
    const paginatedPackIds = validPackIds.slice(parsedOffset, parsedOffset + parsedLimit);
    // Step 6: Fetch full pack data for paginated IDs with same sorting
    let packs: LevelPack[] = [];
    if (paginatedPackIds.length > 0) {
      packs = await LevelPack.findAll({
        where: { id: { [Op.in]: paginatedPackIds } },
        include: [{
          model: User,
          as: 'packOwner',
          attributes: ['id', 'nickname', 'username', 'avatarUrl']
        },
        {
          model: LevelPackItem,
          attributes: ['levelId'],
          as: 'packItems',
          include: [{
            model: Level,
            where: {
              isDeleted: false,
              isHidden: false
            },
            as: 'referencedLevel',
            attributes: ['id', 'artist', 'song', 'diffId'],
            required: true,
            include: [{
              model: LevelCredit,
              as: 'levelCredits',
              required: false,
              include: [{
                model: Creator,
                as: 'creator',
                required: false
              }],
            },
            {
              model: Team,
              as: 'teamObject'
            }
          ]
          }],
          required: false,
        }],
        order: [
          ['isPinned', 'DESC'], // Maintain same sorting order
          [sortField, order]
        ]
      });
    }

    // Get favorites for current user
    const favoritedPacks = req.user ? await PackFavorite.findAll({
      where: {
        userId: req.user.id,
        packId: { [Op.in]: paginatedPackIds }
      }
    }) : [];

    return res.json({
      packs: packs.map(pack => ({
        ...pack.toJSON(),
        id: pack.linkCode,
        isFavorited: favoritedPacks.some(favorite => favorite.packId === pack.id),
        packItems: pack.packItems?.filter(item => item.referencedLevel !== null).slice(0, 3),
        totalLevelCount: pack.packItems?.length
      })),
      total: totalCount,
      offset: parsedOffset,
      limit: parsedLimit
    });

  } catch (error) {
    logger.error('Error fetching packs:', error);
    return res.status(500).json({ error: 'Failed to fetch packs' });
  }
});

// GET /packs/favorites - Get user's favorited packs
// NOTE: This must be before GET /:id to avoid route collision
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

// GET /packs/:id - Get specific pack with its content tree
router.get('/:id', Auth.addUserToRequest(), async (req: Request, res: Response) => {
  try {
    const param = req.params.id;
    const { tree = 'true' } = req.query;
    const resolvedPackId = await resolvePackId(param);
    logger.info('Resolved pack ID:', resolvedPackId);
    if (!resolvedPackId) {
      return res.status(404).json({ error: 'Pack not found' });
    }
    const pack = await LevelPack.findByPk(resolvedPackId, {
      include: [{
        model: User,
        as: 'packOwner',
        attributes: ['id', 'nickname', 'username', 'avatarUrl']
      },
      {
        model: LevelPackItem,
        as: 'packItems',
        required: false
      }
    ]
    });

    if (!canViewPack(pack!, req.user)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Fetch all items in the pack (without complex includes for performance)
    const allItems = pack!.packItems!;
    // Separate items by type
    const folders = allItems.filter(item => item.type === 'folder');
    const levelItems = allItems.filter(item => item.type === 'level' && item.levelId !== null);
    const fetchedLevels = await Level.findAll({
      where: { id: { [Op.in]: levelItems.map(item => item.levelId!) } }
    });

    // Get unique level IDs
    const levelIds = [...new Set(levelItems.map(item => item.levelId!).filter(id => id !== null))];

    // Fetch all related data concurrently
    const [curations, levelCredits, fetchedTeams, tags, metadataResponses, clearedLevelIds] = await Promise.all([
      // Fetch curations with their types
      levelIds.length > 0 ? Curation.findAll({
        where: { levelId: { [Op.in]: levelIds } },
        include: [{
          model: CurationType,
          as: 'type',
          required: false
        }]
      }) : Promise.resolve([]),
      // Fetch level credits with creators
      levelIds.length > 0 ? LevelCredit.findAll({
        where: { levelId: { [Op.in]: levelIds } },
        include: [{
          model: Creator,
          as: 'creator',
          required: false
        }]
      }) : Promise.resolve([]),
      // Fetch teams if needed
      fetchedLevels.length > 0 ? Team.findAll({
        where: { id: { [Op.in]: fetchedLevels.map(level => level.teamId) } }
      }) : Promise.resolve([]),
      // Fetch tags for all levels
      levelIds.length > 0 ? (async () => {
        // Get all tag assignments for these levels
        const assignments = await sequelize.query(
          `SELECT levelId, tagId FROM level_tag_assignments WHERE levelId IN (${levelIds.join(',')})`,
          { type: QueryTypes.SELECT }
        ) as Array<{ levelId: number; tagId: number }>;
        
        if (assignments.length === 0) {
          return new Map<number, LevelTag[]>();
        }
        
        // Get unique tag IDs
        const tagIds = [...new Set(assignments.map(a => a.tagId))];
        
        // Fetch all tags
        const allTags = await LevelTag.findAll({
          where: { id: { [Op.in]: tagIds } },
          order: [['name', 'ASC']]
        });
        
        // Map tags to levels
        const tagsByLevelId = new Map<number, LevelTag[]>();
        const tagsById = new Map(allTags.map((tag: LevelTag) => [tag.id, tag]));
        
        assignments.forEach(assignment => {
          const tag = tagsById.get(assignment.tagId);
          if (tag) {
            if (!tagsByLevelId.has(assignment.levelId)) {
              tagsByLevelId.set(assignment.levelId, []);
            }
            tagsByLevelId.get(assignment.levelId)!.push(tag);
          }
        });
        
        return tagsByLevelId;
      })() : Promise.resolve(new Map<number, LevelTag[]>()),
      levelIds.length > 0 ? cdnService.getBulkLevelMetadata(fetchedLevels) : Promise.resolve([]),
      req.user ? Pass.findAll({
        where: { playerId: req.user.playerId, isDeleted: false },
        attributes: ['levelId']
      }).then(passes => passes.map(pass => pass.levelId)) : Promise.resolve([])
    ]);
    // Build maps for efficient lookup
    const levelsMap = new Map(fetchedLevels.map(level => [level.id, level]));
    const curationsMap = new Map(curations.map(curation => [curation.levelId, curation]));
    const levelCreditsMap = new Map<number, LevelCredit[]>();
    const teamsMap = new Map(fetchedTeams.map(team => [team.id, team]));

    // Group level credits by levelId
    levelCredits.forEach(credit => {
      if (!levelCreditsMap.has(credit.levelId)) {
        levelCreditsMap.set(credit.levelId, []);
      }
      levelCreditsMap.get(credit.levelId)!.push(credit);
    });

    // Attach related data to level items
    const levels = levelItems.map(item => {
      const level = levelsMap.get(item.levelId!);
      if (!level) {
        return null; // Skip items with deleted/hidden levels
      }

      const levelData: any = level.toJSON();
      
      // Attach curation if exists
      const curation = curationsMap.get(level.id);
      if (curation) {
        levelData.curation = curation.toJSON();
      }

      // Attach level credits if exist
      const credits = levelCreditsMap.get(level.id);
      if (credits) {
        levelData.levelCredits = credits.map(credit => credit.toJSON());
      }

      // Attach team if exists
      if (level.teamId) {
        const team = teamsMap.get(level.teamId);
        if (team) {
          levelData.teamObject = team.toJSON();
        }
      }

      // Attach tags if exist
      const levelTags = tags.get(level.id);
      if (levelTags) {
        levelData.tags = levelTags.map(tag => tag.toJSON());
      } else {
        levelData.tags = [];
      }

      return {
        ...item.toJSON(),
        referencedLevel: levelData
      };
    }).filter(item => item !== null);

    const levelMetadataByLevelId = new Map<number, {
      fileId: string;
      size?: number;
      originalFilename?: string;
    }>();

    try {
      // Use fetchedLevels (Level model instances) for CDN metadata
      if (fetchedLevels.length > 0) {
        for (let i = 0; i < fetchedLevels.length; i++) {
          const level = fetchedLevels[i];
          const metadata = metadataResponses[i]?.metadata;
          if (level.id && metadata) {
            levelMetadataByLevelId.set(level.id, {
              fileId: metadataResponses[i]?.fileId,
              size: metadata.originalZip.size,
              originalFilename: metadata.originalZip.originalFilename || metadata.originalZip.name
            });
          }
        }
      }
    } catch (error) {
      logger.error('Error fetching CDN metadata for pack levels:', {
        error: error instanceof Error ? error.message : String(error),
        packId: pack?.id
      });
    }

    const packData: any = pack!.toJSON();

    // Convert folders to plain objects for consistency
    const foldersPlain = folders.map(folder => folder.toJSON());
    let items = [...foldersPlain, ...levels];

    items = items.map((item: any) => {
      const baseItem = {
        ...item,
        isCleared: clearedLevelIds.includes(item.levelId || 0)
      };

      if (baseItem.type === 'level' && baseItem.levelId) {
        const metadata = levelMetadataByLevelId.get(baseItem.levelId);
        if (metadata) {
          baseItem.downloadSizeBytes = metadata.size ?? null;
          baseItem.cdnDownload = {
            fileId: metadata.fileId,
            size: metadata.size ?? null,
            originalFilename: metadata.originalFilename || null
          };
        } else {
          baseItem.downloadSizeBytes = null;
        }
      }

      return baseItem;
    });



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

router.post('/:id/download-link', Auth.verified(), async (req: Request, res: Response) => {
  try {
    const param = req.params.id;
    const { folderId, downloadId } = req.body ?? {};

    const resolvedPackId = await resolvePackId(param);
    if (!resolvedPackId) {
      return res.status(404).json({ error: 'Pack not found' });
    }

    const pack = await LevelPack.findByPk(resolvedPackId, {
      include: [{
        model: User,
        as: 'packOwner',
        attributes: ['id']
      }]
    });

    if (!pack) {
      return res.status(404).json({ error: 'Pack not found' });
    }

    if (!canViewPack(pack, req.user)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const packItems = await LevelPackItem.findAll({
      where: { packId: pack.id },
      include: [{
        model: Level,
        as: 'referencedLevel',
        required: false
      }],
      order: [['sortOrder', 'ASC']]
    });

    const targetFolderId = folderId !== undefined ? Number(folderId) : null;
    let targetFolder: LevelPackItem | null = null;
    if (targetFolderId !== null) {
      targetFolder = packItems.find(item => item.id === targetFolderId && item.type === 'folder') || null;
      if (!targetFolder) {
        return res.status(404).json({ error: 'Folder not found in pack' });
      }
    }

    const itemsByParent = new Map<number | null, LevelPackItem[]>();
    for (const item of packItems) {
      const parentKey = item.parentId ?? null;
      if (!itemsByParent.has(parentKey)) {
        itemsByParent.set(parentKey, []);
      }
      itemsByParent.get(parentKey)!.push(item);
    }

    // Ensure deterministic ordering by sortOrder then id
    itemsByParent.forEach(children => {
      children.sort((a, b) => {
        const sortA = a.sortOrder ?? 0;
        const sortB = b.sortOrder ?? 0;
        if (sortA !== sortB) return sortA - sortB;
        return (a.id ?? 0) - (b.id ?? 0);
      });
    });

    type DownloadTreeNode = {
      type: 'folder' | 'level';
      name: string;
      children?: DownloadTreeNode[];
      fileId?: string | null;
      sourceUrl?: string | null;
      levelId?: number | null;
      packItemId?: number;
    };

    const buildDownloadTree = (parentId: number | null): DownloadTreeNode[] => {
      const children = itemsByParent.get(parentId) ?? [];

      return children.map(child => {
        if (child.type === 'folder') {
          return {
            type: 'folder',
            name: child.name || `Folder ${child.id}`,
            children: buildDownloadTree(child.id),
            packItemId: child.id
          };
        }

        const level: any = child.referencedLevel;
        if (!level) {
          return null;
        }

        const cdnFileId = level.dlLink ? getFileIdFromCdnUrl(level.dlLink) : null;
        const songNamePart = level.song ? ` ${level.song}` : '';
        const displayName = `#${level.id}${songNamePart}`;

        return {
          type: 'level',
          name: displayName,
          fileId: cdnFileId,
          sourceUrl: cdnFileId ? null : (level.dlLink || null),
          levelId: level.id ?? null,
          packItemId: child.id
        };
      }).filter((node) => node !== null) as DownloadTreeNode[];
    };

    const rootChildren = buildDownloadTree(targetFolder ? targetFolder.id : null);

    if (rootChildren.length === 0) {
      return res.status(400).json({ error: 'No levels available for download in the selected scope' });
    }

    const folderOrPackName = targetFolder ? targetFolder.name : pack.name;
    const packCode = pack.linkCode;
    const zipDisplayName = packCode 
      ? `${folderOrPackName} - ${packCode}`
      : folderOrPackName;
    
    const treePayload = {
      type: 'folder',
      name: zipDisplayName,
      children: rootChildren
    };

    const cacheKey = createHash('sha256').update(JSON.stringify(treePayload)).digest('hex');

    const cdnResponse = await cdnService.generatePackDownload({
      zipName: zipDisplayName || 'Missing pack name',
      packId: pack.id,
      packCode: packCode,
      folderId: targetFolder ? targetFolder.id : null,
      cacheKey,
      tree: treePayload,
      downloadId: downloadId || undefined // Client-provided downloadId for progress tracking
    });

    return res.json(cdnResponse);
  } catch (error) {
    if (error instanceof CdnError) {
      if (error.code === 'PACK_SIZE_LIMIT_EXCEEDED') {
        return res.status(400).json({ error: error.message, code: error.code });
      }
      return res.status(500).json({ error: error.message, code: error.code });
    }
    logger.error('Error generating pack download link:', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      packParam: req.params.id
    });
    return res.status(500).json({ error: 'Failed to generate download link' });
  }
});

// POST /packs - Create new pack
router.post('/', Auth.user(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();

  try {
    const { name, iconUrl, cssFlags, viewMode, isPinned } = req.body;
    if (viewMode === LevelPackViewModes.FORCED_PRIVATE) {
      throw { error: 'Forced private packs are not allowed to be created', code: 400 };
    }

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      throw { error: 'Pack name is required', code: 400 };
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

    if (userPackCount >= MAX_PACKS_PER_USER && !hasFlag(req.user, permissionFlags.SUPER_ADMIN)) {
      throw { error: `Maximum ${MAX_PACKS_PER_USER} packs allowed per user`, code: 400 };
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
        throw { error: 'Only administrators can create public packs', code: 403 };
      }
      finalViewMode = viewMode || LevelPackViewModes.PRIVATE;
      // Non-admins cannot set pin status
      if (isPinned) {
        throw { error: 'Only administrators can set pack pin status', code: 403 };
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

  } catch (error: any) {
    await safeTransactionRollback(transaction);
    if (error.code) {
      if (error.code === 500) logger.error('Error creating pack:', error);
      return res.status(error.code).json(error);
    }
    logger.error('Error creating pack:', error);
    return res.status(500).json({ error: 'Failed to create pack' });
  }
});

// PUT /packs/:id - Update pack
router.put('/:id', Auth.user(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();

  try {
    const resolvedPackId = await resolvePackId(req.params.id, transaction);
    if (!resolvedPackId) {
      throw { error: 'Invalid pack ID or link code', code: 400 };
    }

    const pack = await LevelPack.findByPk(resolvedPackId, { transaction });
    if (!pack) {
      throw { error: 'Pack not found', code: 404 };
    }

    if (!canEditPack(pack, req.user)) {
      throw { error: 'Access denied', code: 403 };
    }

    const { name, iconUrl, cssFlags, viewMode, isPinned } = req.body;
    const updateData: any = {};

    if (viewMode === LevelPackViewModes.FORCED_PRIVATE && !hasFlag(req.user, permissionFlags.SUPER_ADMIN)) {
      throw { error: 'Only administrators can force private packs', code: 403 };
    }

    if (name !== undefined) {
      if (typeof name !== 'string' || name.trim().length === 0) {
        throw { error: 'Pack name cannot be empty', code: 400 };
      }
      updateData.name = name.trim();
    }

    if (iconUrl !== undefined) updateData.iconUrl = iconUrl;
    if (cssFlags !== undefined) updateData.cssFlags = cssFlags;

    // Only allow admins to modify pin status
    if (isPinned !== undefined && hasFlag(req.user, permissionFlags.SUPER_ADMIN)) {
      updateData.isPinned = isPinned;
    }

    // Only restrict viewMode changes when involving public visibility
    if (viewMode !== undefined) {
      const isChangingToOrFromPublic =
        viewMode === LevelPackViewModes.PUBLIC ||
        pack.viewMode === LevelPackViewModes.PUBLIC;

      if (isChangingToOrFromPublic && !hasFlag(req.user, permissionFlags.SUPER_ADMIN)) {
        throw { error: 'Only administrators can modify pack visibility to/from public', code: 403 };
      }

      // Additional check for forced private packs
      if (pack.viewMode === LevelPackViewModes.FORCED_PRIVATE && !hasFlag(req.user, permissionFlags.SUPER_ADMIN)) {
        throw { error: 'Cannot modify view mode of admin-locked pack', code: 403 };
      }

      updateData.viewMode = viewMode;
    }

    await pack.update(updateData, { transaction });
    await transaction.commit();

    return res.json({
      ...pack.dataValues,
      id: pack.linkCode,
    });

  } catch (error: any) {
    await safeTransactionRollback(transaction);
    if (error.code) {
      if (error.code === 500) logger.error('Error updating pack:', error);
      return res.status(error.code).json(error);
    }
    logger.error('Error updating pack:', error);
    return res.status(500).json({ error: 'Failed to update pack' });
  }
});

// DELETE /packs/:id - Delete pack
router.delete('/:id', Auth.user(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();

  try {
    const resolvedPackId = await resolvePackId(req.params.id, transaction);
    if (!resolvedPackId) {
      throw { error: 'Invalid pack ID or link code', code: 400 };
    }

    const pack = await LevelPack.findByPk(resolvedPackId, { transaction });
    if (!pack) {
      throw { error: 'Pack not found', code: 404 };
    }

    if (!canEditPack(pack, req.user)) {
      throw { error: 'Access denied', code: 403 };
    }

    await pack.destroy({ transaction });
    await transaction.commit();

    return res.status(204).end();

  } catch (error: any) {
    await safeTransactionRollback(transaction);
    if (error.code) {
      if (error.code === 500) logger.error('Error deleting pack:', error);
      return res.status(error.code).json(error);
    }
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
    const resolvedPackId = await resolvePackId(req.params.id, transaction);
    if (!resolvedPackId) {
      throw { error: 'Invalid pack ID or link code', code: 400 };
    }

    const { type, name, levelIds, parentId, sortOrder } = req.body;

    if (!type || (type !== 'folder' && type !== 'level')) {
      throw { error: 'Type must be "folder" or "level"', code: 400 };
    }

    const pack = await LevelPack.findByPk(resolvedPackId, { transaction });
    if (!pack) {
      throw { error: 'Pack not found', code: 404 };
    }

    if (!canEditPack(pack, req.user)) {
      throw { error: 'Access denied', code: 403 };
    }

    // Validate based on type
    if (type === 'folder') {
      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        throw { error: 'Folder name is required', code: 400 };
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
        throw { error: 'Folder with this name already exists in this location', code: 400 };
      }

      // Validate parent if provided
      if (parentId) {
        const parent = await LevelPackItem.findOne({
          where: { id: parentId, packId: resolvedPackId, type: 'folder' },
          transaction
        });

        if (!parent) {
          throw { error: 'Invalid parent folder', code: 400 };
        }
      }

      // Check item limit
      const itemCount = await LevelPackItem.count({
        where: { packId: resolvedPackId },
        transaction
      });

      if (itemCount >= MAX_ITEMS_PER_PACK && !hasFlag(req.user, permissionFlags.SUPER_ADMIN)) {
        throw { error: `Maximum ${MAX_ITEMS_PER_PACK} items allowed per pack`, code: 400 };
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
      }, { transaction });

      await transaction.commit();

      return res.status(201).json(item);
    } else {
      // type === 'level'
      let levelIdsToAdd: number[] = [];

      // Parse levelIds from string if provided
      if (typeof levelIds === 'number') {
        levelIdsToAdd = [levelIds];
      }
      if (Array.isArray(levelIds) && levelIds.every(id => typeof id === 'number')) {
        levelIdsToAdd = levelIds;
      }
      else if (levelIds && typeof levelIds === 'string') {
        // Extract all numbers from the string using regex
        const numberMatches = levelIds.match(/\d+/g);
        if (numberMatches) {
          levelIdsToAdd = numberMatches.map(match => parseInt(match)).filter(id => !isNaN(id));
        }
      }

      if (levelIdsToAdd.length === 0) {
        throw { error: 'Valid level ID(s) are required', code: 400 };
      }

      // Validate parent if provided
      if (parentId) {
        const parent = await LevelPackItem.findOne({
          where: { id: parentId, packId: resolvedPackId, type: 'folder' },
          transaction
        });

        if (!parent) {
          throw { error: 'Invalid parent folder', code: 400 };
        }
      }

      // Validate all levels exist
      const levels = await Level.findAll({
        where: { id: { [Op.in]: levelIdsToAdd } },
        transaction
      });

      if (levels.length !== levelIdsToAdd.length) {
        throw { error: 'One or more levels not found', code: 404 };
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
        throw { error: 'All specified levels are already in pack', code: 400 };
      }

      // Check item limit
      const currentItemCount = await LevelPackItem.count({
        where: { packId: resolvedPackId },
        transaction
      });

      if (currentItemCount + newLevelIds.length > MAX_ITEMS_PER_PACK) {
        throw {
          error: `Adding ${newLevelIds.length} items would exceed the maximum ${MAX_ITEMS_PER_PACK} items per pack`,
          code: 400,
          details: {
            currentCount: currentItemCount,
            tryingToAdd: newLevelIds.length,
            maxAllowed: MAX_ITEMS_PER_PACK
          }
        };
      }

      // Add all new levels
      let baseSortOrder = sortOrder;
      if (baseSortOrder === undefined || baseSortOrder === null) {
        const maxSortOrder = await LevelPackItem.max('sortOrder', {
          where: { packId: resolvedPackId, parentId: parentId || null },
          transaction
        });
        baseSortOrder = (maxSortOrder as number || 0) + 1;
      }

      const createdItems = [];
      for (let i = 0; i < newLevelIds.length; i++) {
        const levelIdToAdd = newLevelIds[i];
        const finalSortOrder = baseSortOrder + i;

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

  } catch (error: any) {
    await safeTransactionRollback(transaction);
    if (error.code) {
      if (error.code === 500) logger.error('Error adding item to pack:', error);      
      return res.status(error.code).json(error);
    }
    logger.error('Error adding item to pack:', error);
    return res.status(500).json({ error: 'Failed to add item to pack' });
  }
});

// PUT /packs/:id/items/:itemId - Update item
router.put('/:id/items/:itemId', Auth.user(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();

  try {
    const resolvedPackId = await resolvePackId(req.params.id, transaction);
    if (!resolvedPackId) {
      throw { error: 'Invalid pack ID or link code', code: 400 };
    }

    const itemId = parseInt(req.params.itemId);

    if (isNaN(itemId)) {
      throw { error: 'Invalid item ID', code: 400 };
    }

    const pack = await LevelPack.findByPk(resolvedPackId, { transaction });
    if (!pack) {
      throw { error: 'Pack not found', code: 404 };
    }

    if (!canEditPack(pack, req.user)) {
      throw { error: 'Access denied', code: 403 };
    }

    const item = await LevelPackItem.findOne({
      where: { id: itemId, packId: resolvedPackId },
      transaction
    });

    if (!item) {
      throw { error: 'Item not found in pack', code: 404 };
    }

    const { name } = req.body;

    if (item.type === 'folder' && name !== undefined) {
      if (typeof name !== 'string' || name.trim().length === 0) {
        throw { error: 'Folder name cannot be empty', code: 400 };
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
        throw { error: 'Folder with this name already exists in this location', code: 400 };
      }

      await item.update({ name: name.trim() }, { transaction });
    }

    await transaction.commit();

    return res.json(item);

  } catch (error: any) {
    await safeTransactionRollback(transaction);
    if (error.code) {
      if (error.code === 500) logger.error('Error updating pack item:', error);
      return res.status(error.code).json(error);
    }
    logger.error('Error updating pack item:', error);
    return res.status(500).json({ error: 'Failed to update pack item' });
  }
});

// PUT /packs/:id/tree - Update entire pack tree structure
router.put('/:id/tree', Auth.user(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();

  try {
    const resolvedPackId = await resolvePackId(req.params.id, transaction);
    if (!resolvedPackId) {
      throw { error: 'Invalid pack ID or link code', code: 400 };
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
      throw { error: 'Some items do not belong to this pack', code: 400 };
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
            throw { error: 'Circular reference detected in folder structure', code: 400 };
          }
          visited.add(currentParentId);
          currentParentId = folderMap.get(currentParentId);
        }
      }
    }

    // Check for unique constraint violations before updating
    // The constraint is on (packId, parentId, name) for folders
    const itemMap = new Map(packItems.map(item => [item.id, item]));
    for (const update of updates) {
      const item = itemMap.get(update.id);
      if (item && item.type === 'folder' && item.name) {
        // Check if moving this folder to the new parent would create a duplicate name
        const existingFolder = await LevelPackItem.findOne({
          where: {
            packId: resolvedPackId,
            type: 'folder',
            parentId: update.parentId,
            name: item.name,
            id: { [Op.ne]: update.id } // Exclude the current item
          },
          transaction
        });

        if (existingFolder) {
          throw { 
            error: `Folder "${item.name}" already exists in the target location`,
            code: 400,
            details: {
              folderId: update.id,
              folderName: item.name,
              targetParentId: update.parentId
            }
          };
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
        required: false,
        include: [{
          model: Curation,
          as: 'curation',
          include: [{
            model: CurationType,
            as: 'type',
            required: false
          }],
          required: false,
        },
        {
          model: LevelCredit,
          as: 'levelCredits',
          required: false,
          include: [{
            model: Creator,
            as: 'creator',
            required: false
          }],
        },
        {
          model: Team,
          as: 'teamObject'
        }
      ]
      }],
      order: [['sortOrder', 'ASC']]
    });

    // Convert Sequelize models to plain objects to avoid circular references
    const plainItems = updatedItems.map(item => item.toJSON());

    const updatedTree = buildItemTree(plainItems);

    return res.json({ items: updatedTree });

  } catch (error: any) {
    await safeTransactionRollback(transaction);
    if (error.code) {
      if (error.code === 500) logger.error('Error updating pack tree:', error);
      return res.status(error.code).json(error);
    }
    logger.error('Error updating pack tree:', error);
    return res.status(500).json({ error: 'Failed to update pack tree' });
  }
});

// ==================== PACK OWNERSHIP TRANSFER ====================

// GET /packs/users/search/:query - Search for users by username (admin only)
router.get('/users/search/:query', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    const query = req.params.query;
    if (!query || query.length < 1) {
      return res.json([]);
    }

    const users = await User.findAll({
      where: {
        [Op.or]: [
          { username: { [Op.like]: `%${query}%` } },
          { nickname: { [Op.like]: `%${query}%` } }
        ]
      },
      attributes: ['id', 'username', 'nickname', 'avatarUrl'],
      limit: 20,
      order: [['username', 'ASC']]
    });

    return res.json(users);
  } catch (error) {
    logger.error('Error searching users:', error);
    return res.status(500).json({ error: 'Failed to search users' });
  }
});

// PUT /packs/:id/transfer-ownership - Transfer pack ownership to another user (admin only)
router.put('/:id/transfer-ownership', Auth.superAdmin(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();

  try {
    const resolvedPackId = await resolvePackId(req.params.id, transaction);
    if (!resolvedPackId) {
      throw { error: 'Invalid pack ID or link code', code: 400 };
    }

    const { newOwnerId } = req.body;

    if (!newOwnerId) {
      throw { error: 'newOwnerId is required', code: 400 };
    }

    const pack = await LevelPack.findByPk(resolvedPackId, { transaction });
    if (!pack) {
      throw { error: 'Pack not found', code: 404 };
    }

    // Check if new owner exists
    const newOwner = await User.findByPk(newOwnerId, { transaction });
    if (!newOwner) {
      throw { error: 'New owner not found', code: 404 };
    }

    // Convert to string to match UUID type
    const newOwnerIdString = String(newOwnerId);

    // Don't allow transferring to the same owner
    if (pack.ownerId === newOwnerIdString) {
      throw { error: 'Pack is already owned by this user', code: 400 };
    }

    // Transfer ownership
    await pack.update({ ownerId: newOwnerIdString }, { transaction });
    await transaction.commit();

    // Fetch updated pack with owner info
    const updatedPack = await LevelPack.findByPk(resolvedPackId, {
      include: [{
        model: User,
        as: 'packOwner',
        attributes: ['id', 'nickname', 'username', 'avatarUrl']
      }]
    });

    return res.json({
      success: true,
      message: 'Pack ownership transferred successfully',
      pack: {
        ...updatedPack!.toJSON(),
        id: updatedPack!.linkCode
      }
    });
  } catch (error: any) {
    await safeTransactionRollback(transaction);
    if (error.code) {
      if (error.code === 500) logger.error('Error transferring pack ownership:', error);
      return res.status(error.code).json(error);
    }
    logger.error('Error transferring pack ownership:', error);
    return res.status(500).json({ error: 'Failed to transfer pack ownership' });
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
    const resolvedPackId = await resolvePackId(req.params.id, transaction);
    if (!resolvedPackId) {
      throw { error: 'Invalid pack ID or link code', code: 400 };
    }

    const { favorited } = req.body;

    if (typeof favorited !== 'boolean') {
      throw { error: 'favorited must be a boolean value', code: 400 };
    }

    // Check if pack exists
    const pack = await LevelPack.findByPk(resolvedPackId, { transaction });
    if (!pack) {
      throw { error: 'Pack not found', code: 404 };
    }

    // Check if pack is admin-locked
    if (pack.viewMode === 4) { // FORCED_PRIVATE
      throw { error: 'Cannot favorite admin-locked pack', code: 403 };
    }

    // Use upsert to handle race conditions and ensure desired state
    if (favorited) {
      // Try to create, but ignore if already exists (race condition)
      try {
        await PackFavorite.create({
          packId: resolvedPackId,
          userId: req.user?.id
        }, { transaction });
      } catch (error: any) {
        // If it's a unique constraint error, the favorite already exists - that's fine
        if (error.name !== 'SequelizeUniqueConstraintError') {
          throw error;
        }
        logger.debug('Favorite already exists', { packId: resolvedPackId, userId: req.user?.id });
        // Otherwise, silently succeed since the desired state is achieved
      }
    } else {
      // Remove favorite if it exists
      await PackFavorite.destroy({
        where: {
          packId: resolvedPackId,
          userId: req.user?.id
        },
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
  } catch (error: any) {
    await safeTransactionRollback(transaction);
    if (error.code) {
      if (error.code === 500) logger.error('Error setting pack favorite status:', error);
      return res.status(error.code).json(error);
    }
    logger.error('Error setting pack favorite status:', error);
    return res.status(500).json({ error: 'Failed to set pack favorite status' });
  }
});

// DELETE /packs/:id/items/:itemId - Delete item
router.delete('/:id/items/:itemId', Auth.user(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();

  try {
    const resolvedPackId = await resolvePackId(req.params.id, transaction);
    if (!resolvedPackId) {
      throw { error: 'Invalid pack ID or link code', code: 400 };
    }

    const itemId = parseInt(req.params.itemId);

    if (isNaN(itemId)) {
      throw { error: 'Invalid item ID', code: 400 };
    }

    const pack = await LevelPack.findByPk(resolvedPackId, { transaction });
    if (!pack) {
      throw { error: 'Pack not found', code: 404 };
    }

    if (!canEditPack(pack, req.user)) {
      throw { error: 'Access denied', code: 403 };
    }

    const item = await LevelPackItem.findOne({
      where: { id: itemId, packId: resolvedPackId },
      transaction
    });

    if (!item) {
      throw { error: 'Item not found in pack', code: 404 };
    }


    await item.destroy({ transaction });
    await transaction.commit();

    return res.status(204).end();

  } catch (error: any) {
    await safeTransactionRollback(transaction);
    if (error.code) {
      if (error.code === 500) logger.error('Error deleting pack item:', error);
      return res.status(error.code).json(error);
    }
    logger.error('Error deleting pack item:', error);
    return res.status(500).json({ error: 'Failed to delete pack item' });
  }
});

// PUT /packs/:id/items/reorder - Reorder multiple items
router.put('/:id/items/reorder', Auth.user(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();

  try {
    const resolvedPackId = await resolvePackId(req.params.id, transaction);
    if (!resolvedPackId) {
      throw { error: 'Invalid pack ID or link code', code: 400 };
    }

    const { items } = req.body;

    if (!Array.isArray(items)) {
      throw { error: 'items must be an array', code: 400 };
    }

    const pack = await LevelPack.findByPk(resolvedPackId, { transaction });
    if (!pack) {
      throw { error: 'Pack not found', code: 404 };
    }

    if (!canEditPack(pack, req.user)) {
      throw { error: 'Access denied', code: 403 };
    }

    // Validate all items belong to this pack and check for unique constraint violations
    const itemIds = items.map((item: any) => item.id).filter((id: any) => id !== undefined);
    const packItems = await LevelPackItem.findAll({
      where: {
        packId: resolvedPackId,
        id: { [Op.in]: itemIds }
      },
      transaction
    });

    if (packItems.length !== itemIds.length) {
      throw { error: 'Some items do not belong to this pack', code: 400 };
    }

    const itemMap = new Map(packItems.map(item => [item.id, item]));

    // Check for unique constraint violations before updating
    // The constraint is on (packId, parentId, name) for folders
    for (const { id, sortOrder, parentId } of items) {
      if (id && parentId !== undefined) {
        const item = itemMap.get(id);
        if (item && item.type === 'folder' && item.name) {
          // Check if moving this folder to the new parent would create a duplicate name
          const existingFolder = await LevelPackItem.findOne({
            where: {
              packId: resolvedPackId,
              type: 'folder',
              parentId: parentId || null,
              name: item.name,
              id: { [Op.ne]: id } // Exclude the current item
            },
            transaction
          });

          if (existingFolder) {
            throw { error: `Folder "${item.name}" already exists in the target location`, code: 400 };
          }
        }
      }
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

  } catch (error: any) {
    await safeTransactionRollback(transaction);
    if (error.code) {
      if (error.code === 500) logger.error('Error reordering pack items:', error);
      return res.status(error.code).json(error);
    }
    logger.error('Error reordering pack items:', error);
    return res.status(500).json({ error: 'Failed to reorder pack items' });
  }
});

export default router;
