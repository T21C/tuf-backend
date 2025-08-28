import {Router, Request, Response, NextFunction} from 'express';
import {Auth} from '../../middleware/auth.js';
import {db} from '../../models/index.js';
import {Op, Transaction} from 'sequelize';
import { getFileIdFromCdnUrl, isCdnUrl } from '../../utils/Utility.js';
import multer from 'multer';
import CdnService from '../../services/CdnService.js';
import Curation from '../../models/curations/Curation.js';
import CurationType from '../../models/curations/CurationType.js';
import Difficulty from '../../models/levels/Difficulty.js';
import Level from '../../models/levels/Level.js';
import CurationSchedule from '../../models/curations/CurationSchedule.js';
import Creator from '../../models/credits/Creator.js';
import { logger } from '../../services/LoggerService.js';
import ElasticsearchService from '../../services/ElasticsearchService.js';
import sequelize from '../../config/db.js';
import { hasAnyFlag, hasFlag } from '../../utils/permissionUtils.js';
import { permissionFlags, curationTypeAbilities } from '../../config/constants.js';
import { canAssignCurationType, hasAbility } from '../../utils/curationTypeUtils.js';

const router: Router = Router();

const elasticsearchService = ElasticsearchService.getInstance();

// Middleware to verify curation management permissions
const requireCurationPermission = (req: Request, res: Response, next: NextFunction) => {
  const { id } = req.params;

  // Super admins can manage all curations
  if (hasAnyFlag(req.user, [permissionFlags.SUPER_ADMIN, permissionFlags.HEAD_CURATOR])) {
    return next();
  }
  
  // Regular curators and raters need to check if they can assign the curation type
  if (hasAnyFlag(req.user, [permissionFlags.CURATOR, permissionFlags.RATER])) {
    return Curation.findByPk(id, {
      include: [{ model: CurationType, as: 'type' }],
    }).then((curation) => {
      if (!curation) {
        return res.status(404).json({error: 'Curation not found'});
      }
      
      // Check if user can assign this curation type based on abilities
      if (curation.type && canAssignCurationType(BigInt(req.user?.permissionFlags || 0), BigInt(curation.type.abilities))) {
        return next();
      }
      
      return res.status(403).json({error: 'You do not have permission to manage this curation'});
    }).catch((error) => {
      logger.error('Error checking curation permission:', error);
      return res.status(500).json({error: 'Internal server error'});
    });
  }
  
  return res.status(403).json({error: 'You do not have permission to manage curations'});
};

// Middleware to verify curation creation permissions (for POST requests)
const requireCurationCreationPermission = (req: Request, res: Response, next: NextFunction) => {
  // Super admins and head curators can create all curations
  if (hasAnyFlag(req.user, [permissionFlags.SUPER_ADMIN, permissionFlags.HEAD_CURATOR])) {
    return next();
  }
  
  // Regular curators and raters can create curations
  if (hasAnyFlag(req.user, [permissionFlags.CURATOR, permissionFlags.RATER])) {
    return next();
  }
  
  return res.status(403).json({error: 'You do not have permission to create curations'});
};

// Combined authentication and permission middleware for curator OR rater
const requireCuratorOrRater = (req: Request, res: Response, next: NextFunction) => {
  // First run base authentication
  return Auth.user()(req, res, (err) => {
    if (err) return next(err);
    
    // Then check permissions
    return requireCurationCreationPermission(req, res, next);
  });
};

const reindexCuratedLevels = async () => {
  const curations = await Curation.findAll({
    include: [
      {
        model: Level,
        as: 'level',
      },
    ],
  });
  const levelIds = curations.map(curation => curation.levelId);
  await elasticsearchService.reindexLevels(levelIds);
};

// Helper function to clean up CDN files for curations
const cleanupCurationCdnFiles = async (curations: Curation[]) => {
  for (const curation of curations) {
    // Clean up curation thumbnail if it exists
    if (curation.previewLink && isCdnUrl(curation.previewLink)) {
      const fileId = getFileIdFromCdnUrl(curation.previewLink);
      if (fileId) {
        try {
          logger.info(`Deleting curation thumbnail ${fileId} from CDN`);
          await CdnService.deleteFile(fileId);
          logger.info(`Successfully deleted curation thumbnail ${fileId} from CDN`);
        } catch (error) {
          logger.error(`Error deleting curation thumbnail ${fileId} from CDN:`, error);
          // Continue with cleanup even if CDN deletion fails
        }
      }
    }
  }
};

// Helper function to clean up CDN files for curation types
const cleanupCurationTypeCdnFiles = async (type: CurationType) => {
  // Clean up curation type icon if it exists
  if (type.icon && isCdnUrl(type.icon)) {
    const fileId = getFileIdFromCdnUrl(type.icon);
    if (fileId) {
      try {
        logger.info(`Deleting curation type icon ${fileId} from CDN`);
        await CdnService.deleteFile(fileId);
        logger.info(`Successfully deleted curation type icon ${fileId} from CDN`);
      } catch (error) {
        logger.error(`Error deleting curation type icon ${fileId} from CDN:`, error);
        // Continue with cleanup even if CDN deletion fails
      }
    }
  }
};

// Configure multer for file uploads
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 10 * 1024 * 1024,
    },
    fileFilter: (req, file, cb) => {
        const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/svg+xml'];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Only JPEG, PNG, WebP, and SVG files are allowed.'));
        }
    }
});

// Get all curation types
router.get('/types', async (req, res) => {
  try {
    const types = await CurationType.findAll({
      order: [['sortOrder', 'ASC'], ['name', 'ASC']],
    });
    
    // Convert BigInt abilities to string for JSON serialization
    const serializedTypes = types.map(type => ({
      ...type.toJSON(),
      abilities: type.abilities.toString()
    }));
    
    return res.json(serializedTypes);
  } catch (error) {
    logger.error('Error fetching curation types:', error);
    return res.status(500).json({error: 'Internal server error'});
  }
});

// Create curation type
router.post('/types', Auth.superAdminPassword(), async (req, res) => {
  try {
    const {name, icon, color, abilities} = req.body;
    
    if (!name) {
      return res.status(400).json({error: 'Name is required'});
    }

    // Check for duplicate name (case-insensitive)
    const existingType = await CurationType.findOne({
      where: sequelize.where(
        sequelize.fn('LOWER', sequelize.col('name')), 
        '=', 
        name.trim().toLowerCase()
      )
    });

    if (existingType) {
      return res.status(409).json({error: 'A curation type with this name already exists'});
    }

    const type = await CurationType.create({
      name: name.trim(),
      icon,
      color: color || '#ffffff',
      abilities: abilities ? BigInt(abilities) : 0n,
      sortOrder: 0,
    });

    await reindexCuratedLevels();

    // Convert BigInt abilities to string for JSON serialization
    const serializedType = {
      ...type.toJSON(),
      abilities: type.abilities.toString()
    };

    return res.status(201).json(serializedType);
  } catch (error) {
    logger.error('Error creating curation type:', error);
    return res.status(500).json({error: 'Internal server error'});
  }
});

// Update curation type
router.put('/types/:id([0-9]+)', Auth.superAdminPassword(), async (req, res) => {
  try {
    const {id} = req.params;
    const {name, icon, color, abilities} = req.body;

    const type = await CurationType.findByPk(id);
    if (!type) {
      return res.status(404).json({error: 'Curation type not found'});
    }

    // Check for duplicate name (case-insensitive) if name is being updated
    if (name && name !== type.name) {
      const existingType = await CurationType.findOne({
        where: {
          [Op.and]: [
            sequelize.where(
              sequelize.fn('LOWER', sequelize.col('name')), 
              '=', 
              name.trim().toLowerCase()
            ),
            {
              id: {
                [Op.ne]: id // Exclude current type from check
              }
            }
          ]
        }
      });

      if (existingType) {
        return res.status(409).json({error: 'A curation type with this name already exists'});
      }
    }

    await type.update({
      name: name ? name.trim() : type.name,
      icon,
      color,
      abilities: abilities ? BigInt(abilities) : type.abilities,
    });

    await reindexCuratedLevels();

    // Convert BigInt abilities to string for JSON serialization
    const serializedType = {
      ...type.toJSON(),
      abilities: type.abilities.toString()
    };

    return res.json(serializedType);
  } catch (error) {
    logger.error('Error updating curation type:', error);
    return res.status(500).json({error: 'Internal server error'});
  }
});

// Delete curation type
router.delete('/types/:id([0-9]+)', Auth.superAdminPassword(), async (req, res) => {
  const transaction = await sequelize.transaction();
  
  try {
    const {id} = req.params;

    const type = await CurationType.findByPk(id, { transaction });
    if (!type) {
      await transaction.rollback();
      return res.status(404).json({error: 'Curation type not found'});
    }

    // Find all curations of this type to clean up their CDN files
    const curations = await Curation.findAll({
      where: { typeId: id },
      transaction
    });

    const affectedLevelIds = curations.map(curation => curation.levelId);

    logger.info(`Found ${curations.length} curations to clean up for curation type ${id}`);

    // Clean up CDN files for all curations of this type
    await cleanupCurationCdnFiles(curations);

    // Clean up CDN files for the curation type itself
    await cleanupCurationTypeCdnFiles(type);

    // Delete the curation type (this will cascade delete all related curations and schedules)
    await type.destroy({ transaction });

    await transaction.commit();
    
    // Reindex affected levels after successful deletion
    await elasticsearchService.reindexLevels(affectedLevelIds);
    
    logger.info(`Successfully deleted curation type ${id} and cleaned up ${curations.length} related curations`);
    return res.status(204).send();
  } catch (error) {
    await transaction.rollback();
    logger.error('Error deleting curation type:', error);
    return res.status(500).json({error: 'Internal server error'});
  }
});

// Upload curation icon
router.post('/types/:id([0-9]+)/icon', Auth.superAdminPassword(), upload.single('icon'), async (req, res) => {
  try {
    const {id} = req.params;
    
    if (!req.file) {
      return res.status(400).json({error: 'No icon file uploaded'});
    }

    const type = await CurationType.findByPk(id);
    if (!type) {
      return res.status(404).json({error: 'Curation type not found'});
    }

    // Upload to CDN
    const filename = `curation_icon_${id}_${Date.now()}.${req.file.originalname.split('.').pop()}`;
    const cdnResult = await CdnService.uploadCurationIcon(req.file.buffer, filename);

    // Update curation type with icon URL
    await type.update({
      icon: cdnResult.urls.original || cdnResult.urls.medium
    });

    return res.json({
      success: true,
      icon: type.icon,
      cdnData: cdnResult
    });
  } catch (error) {
    logger.error('Error uploading curation icon:', error);
    return res.status(500).json({error: 'Failed to upload icon'});
  }
});

// Delete curation icon
router.delete('/types/:id([0-9]+)/icon', Auth.superAdminPassword(), async (req, res) => {
  const transaction = await sequelize.transaction();
  
  try {
    const {id} = req.params;

    const type = await CurationType.findByPk(id, { transaction });
    if (!type) {
      await transaction.rollback();
      return res.status(404).json({error: 'Curation type not found'});
    }

    // Clean up CDN files for the curation type
    await cleanupCurationTypeCdnFiles(type);

    // Clear the icon field
    await type.update({icon: null}, { transaction });

    await transaction.commit();

    return res.json({success: true, message: 'Icon removed successfully'});
  } catch (error) {
    await transaction.rollback();
    logger.error('Error deleting curation icon:', error);
    return res.status(500).json({error: 'Failed to delete icon'});
  }
});

// Update curation type sort orders
router.put('/types/sort-orders', Auth.superAdminPassword(), async (req, res) => {
  const transaction = await sequelize.transaction();
  
  try {
    const { sortOrders } = req.body;
    
    if (!sortOrders || !Array.isArray(sortOrders)) {
      await transaction.rollback();
      return res.status(400).json({error: 'Sort orders array is required'});
    }

    // Update each curation type's sort order
    for (const { id, sortOrder } of sortOrders) {
      const type = await CurationType.findByPk(id, { transaction });
      if (type) {
        await type.update({ sortOrder }, { transaction });
      }
    }

    await transaction.commit();
    
    // Reindex curated levels after sort order changes
    await reindexCuratedLevels();
    
    logger.info(`Successfully updated sort orders for ${sortOrders.length} curation types`);
    return res.json({success: true, message: 'Sort orders updated successfully'});
  } catch (error) {
    await transaction.rollback();
    logger.error('Error updating curation type sort orders:', error);
    return res.status(500).json({error: 'Internal server error'});
  }
});

// Get all curations with pagination and filters
router.get('/', async (req, res) => {
  try {
    const {page = 1, limit = 20, typeId, levelId, search, excludeIds} = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    const where: any = {};
    if (typeId) where.typeId = typeId;
    if (levelId) where.levelId = levelId;
    
    // Add excludeIds filter if provided
    if (excludeIds) {
      const excludeArray = Array.isArray(excludeIds) ? excludeIds : [excludeIds];
      where.id = { [Op.notIn]: excludeArray };
    }

    // Handle search differently to avoid count inconsistencies
    let curations;
    
    if (search) {
      const searchStr = Array.isArray(search) ? String(search[0]) : String(search);
      
      // Check if search starts with # for direct level ID lookup
      if (searchStr && searchStr.startsWith('#') && searchStr.length > 1) {
        const levelId = searchStr.substring(1); // Remove the # and get the level ID
        
        // Validate that the level ID is a number
        if (!/^\d+$/.test(levelId)) {
          return res.status(400).json({error: 'Invalid level ID format after hashtag'});
        }
        
        // Direct lookup by level ID
        where.levelId = parseInt(levelId);
        
        const include = [
          {
            model: CurationType,
            as: 'type',
          },
          {
            model: Level,
            as: 'level',
            include: [
              {
                model: Difficulty,
                as: 'difficulty',
              },
              {
                model: Creator,
                as: 'levelCreators',
              },
            ],
          },
        ];

        curations = await Curation.findAndCountAll({
          where,
          include,
          limit: Number(limit),
          offset,
          order: [['createdAt', 'DESC']],
          distinct: true,
        });
        
        logger.info(`Direct level ID lookup for level ${levelId}: found ${curations.count} curations`);
      } else {
        // Regular text search
        const searchWhere = {
          [Op.or]: [
            {song: {[Op.like]: `%${search}%`}},
            {artist: {[Op.like]: `%${search}%`}},
            {creator: {[Op.like]: `%${search}%`}},
          ],
        };
        
        // First get the level IDs that match the search
        const matchingLevels = await Level.findAll({
          where: searchWhere,
          attributes: ['id'],
        });
        
        const matchingLevelIds = matchingLevels.map(level => level.id);
        
        // Update the where clause to filter by matching level IDs
        where.levelId = { [Op.in]: matchingLevelIds };
        
        const include = [
          {
            model: CurationType,
            as: 'type',
          },
          {
            model: Level,
            as: 'level',
            include: [
              {
                model: Difficulty,
                as: 'difficulty',
              },
              {
                model: Creator,
                as: 'levelCreators',
              },
            ],
          },
        ];

        curations = await Curation.findAndCountAll({
          where,
          include,
          limit: Number(limit),
          offset,
          order: [['createdAt', 'DESC']],
          distinct: true, // Add distinct to avoid duplicate counting from joins
        });
      }
    } else {
      // No search - use original approach
      const include = [
        {
          model: CurationType,
          as: 'type',
        },
        {
          model: Level,
          as: 'level',
          include: [
            {
              model: Difficulty,
              as: 'difficulty',
            },
            {
              model: Creator,
              as: 'levelCreators',
            },
          ],
        },
      ];

      curations = await Curation.findAndCountAll({
        where,
        include,
        limit: Number(limit),
        offset,
        order: [['createdAt', 'DESC']],
        distinct: true, // Add distinct to avoid duplicate counting from joins
      });
    }

    // Serialize BigInt abilities to string for all curations
    const serializedCurations = curations.rows.map(curation => ({
      ...curation.toJSON(),
      type: curation.type ? {
        ...curation.type.toJSON(),
        abilities: curation.type.abilities.toString()
      } : null
    }));

    logger.info(`Found ${curations.count} curations on page ${page}`);
    return res.json({
      curations: serializedCurations,
      total: curations.count,
      page: Number(page),
      totalPages: Math.ceil(curations.count / Number(limit)),
    });
  } catch (error) {
    logger.error('Error fetching curations:', error);
    return res.status(500).json({error: 'Internal server error'});
  }
});

// Create curation
router.post('/', requireCuratorOrRater, async (req: Request, res: Response) => {
  try {
    const {levelId} = req.body;
    const assignedBy = req.user?.id || 'unknown';

    if (!levelId) {
      return res.status(400).json({error: 'Level ID is required'});
    }

    // Check if level exists
    const level = await Level.findByPk(levelId);
    if (!level) {
      return res.status(404).json({error: 'Level not found'});
    }

    // Check for existing curation for this level
    const existingCuration = await Curation.findOne({
      where: { levelId }
    });

    if (existingCuration) {
      return res.status(409).json({error: 'This level is already curated'});
    }

    // Get all curation types ordered by sort order (highest first)
    const allCurationTypes = await CurationType.findAll({
      order: [['sortOrder', 'DESC']]
    });

    if (allCurationTypes.length === 0) {
      return res.status(500).json({error: 'No curation types found'});
    }

    // Find the first assignable curation type for this user
    const userFlags = BigInt(req.user?.permissionFlags || 0);
    const assignableType = allCurationTypes.find(type => 
      canAssignCurationType(userFlags, BigInt(type.abilities))
    );

    if (!assignableType) {
      return res.status(403).json({error: 'You do not have permission to assign any curation types'});
    }

    const curation = await Curation.create({
      levelId,
      typeId: assignableType.id,
      assignedBy
    });

    // Fetch the complete curation with related data
    const completeCuration = await Curation.findByPk(curation.id, {
      include: [
        {
          model: CurationType,
          as: 'type',
        },
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
      ],
    });

    // Serialize BigInt abilities to string
    const serializedCuration = completeCuration ? {
      ...completeCuration.toJSON(),
      type: completeCuration.type ? {
        ...completeCuration.type.toJSON(),
        abilities: completeCuration.type.abilities.toString()
      } : null
    } : null;

    return res.status(201).json({ curation: serializedCuration });
  } catch (error) {
    logger.error('Error creating curation:', error);
    return res.status(500).json({error: 'Internal server error'});
  }
});

// Update curation
router.put('/:id([0-9]+)', requireCurationPermission, async (req: Request, res: Response) => {
  try {
    const {id} = req.params;
    const {shortDescription, description, previewLink, customCSS, customColor, typeId} = req.body;

    const curation = await Curation.findByPk(id);
    if (!curation) {
      return res.status(404).json({error: 'Curation not found'});
    }

    await curation.update({
      shortDescription,
      description,
      previewLink,
      customCSS,
      customColor,
      typeId: typeId || curation.typeId,
    });

    // Fetch the complete curation with related data
    const completeCuration = await Curation.findByPk(id, {
      include: [
        {
          model: CurationType,
          as: 'type',
        },
        {
          model: Level,
          as: 'level',
          include: [
            {
              model: Difficulty,
              as: 'difficulty',
            },
            {
              model: Creator,
              as: 'levelCreators',
            }
          ],
        },
      ],
    });

    // Serialize BigInt abilities to string
    const serializedCuration = completeCuration ? {
      ...completeCuration.toJSON(),
      type: completeCuration.type ? {
        ...completeCuration.type.toJSON(),
        abilities: completeCuration.type.abilities.toString()
      } : null
    } : null;

    return res.json({ curation: serializedCuration });
  } catch (error) {
    logger.error('Error updating curation:', error);
    return res.status(500).json({error: 'Internal server error'});
  }
});

// Get single curation
router.get('/:id([0-9]+)', async (req, res) => {
  try {
    const {id} = req.params;

    const curation = await Curation.findByPk(id, {
      include: [
        {
          model: CurationType,
          as: 'type',
        },
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
      ],
    });

    if (!curation) {
      return res.status(404).json({error: 'Curation not found'});
    }

    // Serialize BigInt abilities to string
    const serializedCuration = {
      ...curation.toJSON(),
      type: curation.type ? {
        ...curation.type.toJSON(),
        abilities: curation.type.abilities.toString()
      } : null
    };

    return res.json(serializedCuration);
  } catch (error) {
    logger.error('Error fetching curation:', error);
    return res.status(500).json({error: 'Internal server error'});
  }
});

// Delete curation
router.delete('/:id([0-9]+)', requireCurationPermission, async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  
  try {
    const {id} = req.params;

    const curation = await Curation.findByPk(id, { transaction });
    if (!curation) {
      await transaction.rollback();
      return res.status(404).json({error: 'Curation not found'});
    }

    // Clean up CDN files for this curation
    await cleanupCurationCdnFiles([curation]);

    // Store levelId for reindexing
    const levelId = curation.levelId;

    // Delete the curation (this will cascade delete related schedules)
    await curation.destroy({ transaction });

        await transaction.commit();
    
    logger.info(`Successfully deleted curation ${id} and cleaned up related resources`);
    return res.status(200).json({
      success: true,
      message: 'Curation deleted successfully',
    });
  } catch (error) {
    await transaction.rollback();
    logger.error('Error deleting curation:', error);
    return res.status(500).json({error: 'Internal server error'});
  }
});

// Get curation schedules
router.get('/schedules', async (req, res) => {
  try {
    const { weekStart } = req.query;
    
    const where: any = { isActive: true };
    if (weekStart) {
      // Convert any date to the start of the week (Monday)
      const inputDate = new Date(weekStart as string);
      const dayOfWeek = inputDate.getDay(); // 0 = Sunday, 1 = Monday, etc.
      const daysToSubtract = dayOfWeek === 0 ? 6 : dayOfWeek - 1; // Convert to Monday-based week
      
      const startOfWeek = new Date(inputDate);
      startOfWeek.setDate(inputDate.getDate() - daysToSubtract);
      
      where.weekStart = startOfWeek;
    }

    const schedules = await CurationSchedule.findAll({
      where,
      include: [
        {
          model: Curation,
          as: 'scheduledCuration',
          include: [
            {
              model: CurationType,
              as: 'type',
            },
            {
              model: Level,
              as: 'level',
              include: [
                {
                  model: Difficulty,
                  as: 'difficulty',
                },
                {
                  model: Creator,
                  as: 'levelCreators',
                }
              ],
            },
          ],
        },
      ],
      order: [['listType', 'ASC'], ['position', 'ASC']],
    });

    // Serialize BigInt abilities to string for all schedules
    const serializedSchedules = schedules.map(schedule => ({
      ...schedule.toJSON(),
      scheduledCuration: schedule.scheduledCuration ? {
        ...schedule.scheduledCuration.toJSON(),
        type: schedule.scheduledCuration.type ? {
          ...schedule.scheduledCuration.type.toJSON(),
          abilities: schedule.scheduledCuration.type.abilities.toString()
        } : null
      } : null
    }));

    return res.json({
      schedules: serializedSchedules,
    });
  } catch (error) {
    logger.error('Error fetching curation schedules:', error);
    return res.status(500).json({error: 'Internal server error'});
  }
});

// Create curation schedule
router.post('/schedules', Auth.headCurator(), async (req, res) => {
  try {
    const { curationId, weekStart, listType, position } = req.body;
    const scheduledBy = req.user?.id || 'unknown';

    if (!curationId || !weekStart || !listType || position === undefined) {
      return res.status(400).json({error: 'Curation ID, Week Start, List Type, and Position are required'});
    }

    // Check if curation exists
    const curation = await Curation.findByPk(curationId);
    if (!curation) {
      return res.status(404).json({error: 'Curation not found'});
    }

    // Validate listType
    if (!['primary', 'secondary'].includes(listType)) {
      return res.status(400).json({error: 'List type must be either "primary" or "secondary"'});
    }

    // Validate position (0-9)
    if (position < 0 || position > 9) {
      return res.status(400).json({error: 'Position must be between 0 and 9'});
    }

    // Check for existing schedule for this curation in the same week and list type
    const weekStartDate = new Date(weekStart);
    const existingSchedule = await CurationSchedule.findOne({
      where: {
        curationId,
        weekStart: weekStartDate,
        listType,
        isActive: true
      }
    });

    if (existingSchedule) {
      return res.status(409).json({error: 'This curation is already scheduled for this week and list type'});
    }

    // Check for position conflict in the same week and list type
    const positionConflict = await CurationSchedule.findOne({
      where: {
        weekStart: weekStartDate,
        listType,
        position,
        isActive: true
      }
    });

    if (positionConflict) {
      return res.status(409).json({error: 'Position is already occupied for this week and list type'});
    }

    const schedule = await CurationSchedule.create({
      curationId,
      weekStart: weekStartDate,
      listType,
      position,
      scheduledBy,
      isActive: true,
    });

    // Fetch the complete schedule with related data
    const completeSchedule = await CurationSchedule.findByPk(schedule.id, {
      include: [
        {
          model: Curation,
          as: 'scheduledCuration',
          include: [
            {
              model: CurationType,
              as: 'type',
            },
            {
              model: Level,
              as: 'level',
              include: [
                {
                  model: Difficulty,
                  as: 'difficulty',
                },
                {
                  model: Creator,
                  as: 'levelCreators',
                }
            
              ],
            },
          ],
        },
      ],
    });

    // Serialize BigInt abilities to string
    const serializedSchedule = completeSchedule ? {
      ...completeSchedule.toJSON(),
      scheduledCuration: completeSchedule.scheduledCuration ? {
        ...completeSchedule.scheduledCuration.toJSON(),
        type: completeSchedule.scheduledCuration.type ? {
          ...completeSchedule.scheduledCuration.type.toJSON(),
          abilities: completeSchedule.scheduledCuration.type.abilities.toString()
        } : null
      } : null
    } : null;

    return res.status(201).json(serializedSchedule);
  } catch (error) {
    logger.error('Error creating curation schedule:', error);
    return res.status(500).json({error: 'Internal server error'});
  }
});

// Update curation schedule
router.put('/schedules/:id', Auth.headCurator(), async (req, res) => {
  try {
    const { id } = req.params;
    const { position, isActive } = req.body;

    const schedule = await CurationSchedule.findByPk(id);
    if (!schedule) {
      return res.status(404).json({error: 'Curation schedule not found'});
    }

    // Validate position if provided
    if (position !== undefined && (position < 0 || position > 9)) {
      return res.status(400).json({error: 'Position must be between 0 and 9'});
    }

    // Check for position conflict if position is being updated
    if (position !== undefined && position !== schedule.position) {
      const positionConflict = await CurationSchedule.findOne({
        where: {
          weekStart: schedule.weekStart,
          listType: schedule.listType,
          position,
          isActive: true,
          id: {
            [Op.ne]: id // Exclude current schedule from check
          }
        }
      });

      if (positionConflict) {
        return res.status(409).json({error: 'Position is already occupied for this week and list type'});
      }
    }

    await schedule.update({
      position: position !== undefined ? position : schedule.position,
      isActive: isActive !== undefined ? isActive : schedule.isActive,
    });

    return res.json(schedule);
  } catch (error) {
    logger.error('Error updating curation schedule:', error);
    return res.status(500).json({error: 'Internal server error'});
  }
});

// Delete curation schedule
router.delete('/schedules/:id', Auth.headCurator(), async (req, res) => {
  try {
    const { id } = req.params;

    const schedule = await CurationSchedule.findByPk(id);
    if (!schedule) {
      return res.status(404).json({error: 'Curation schedule not found'});
    }

    await schedule.destroy();
    return res.status(204).send();
  } catch (error) {
    logger.error('Error deleting curation schedule:', error);
    return res.status(500).json({error: 'Internal server error'});
  }
});

// Upload level thumbnail
router.post('/:id([0-9]+)/thumbnail', [requireCurationPermission, upload.single('thumbnail')], async (req: Request, res: Response) => {
  try {
    const {id} = req.params;
    
    if (!req.file) {
      return res.status(400).json({error: 'No thumbnail file uploaded'});
    }

    const curation = await Curation.findByPk(id);
    if (!curation) {
      return res.status(404).json({error: 'Curation not found'});
    }

    // Delete existing thumbnail first if it exists
    if (curation.previewLink && isCdnUrl(curation.previewLink)) {
      const existingFileId = getFileIdFromCdnUrl(curation.previewLink);
      
      if (existingFileId) {
        try {
          logger.info(`Deleting existing thumbnail ${existingFileId} before uploading new one`);
          await CdnService.deleteFile(existingFileId);
          logger.info(`Successfully deleted existing thumbnail ${existingFileId}`);
        } catch (deleteError) {
          logger.error('Error deleting existing thumbnail:', deleteError);
          // Continue with upload even if deletion fails
        }
      }
    }

    // Upload new thumbnail to CDN
    const filename = `level_thumbnail_${id}_${Date.now()}.${req.file.originalname.split('.').pop()}`;
    const cdnResult = await CdnService.uploadLevelThumbnail(req.file.buffer, filename);

    // Update curation with new thumbnail URL
    await curation.update({
      previewLink: cdnResult.urls.original || cdnResult.urls.medium
    });



    return res.json({
      success: true,
      previewLink: curation.previewLink,
      cdnData: cdnResult
    });
  } catch (error) {
    logger.error('Error uploading level thumbnail:', error);
    return res.status(500).json({error: 'Failed to upload thumbnail'});
  }
});

// Delete level thumbnail
router.delete('/:id([0-9]+)/thumbnail', requireCurationPermission, async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  
  try {
    const {id} = req.params;

    const curation = await Curation.findByPk(id, { transaction });
    if (!curation) {
      await transaction.rollback();
      return res.status(404).json({error: 'Curation not found'});
    }

    // Clean up CDN files for this curation
    await cleanupCurationCdnFiles([curation]);

    // Clear the preview link
    await curation.update({previewLink: null}, { transaction });

    await transaction.commit();

    return res.json({success: true, message: 'Thumbnail removed successfully'});
  } catch (error) {
    await transaction.rollback();
    logger.error('Error deleting level thumbnail:', error);
    return res.status(500).json({error: 'Failed to delete thumbnail'});
  }
});

export default router;
