import {Router} from 'express';
import {Auth} from '../../middleware/auth.js';
import {db} from '../../models/index.js';
import {Op} from 'sequelize';
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

const router: Router = Router();

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
router.get('/types', Auth.superAdmin(), async (req, res) => {
  try {
    const types = await CurationType.findAll({
      order: [['name', 'ASC']],
    });
    return res.json(types);
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

    const type = await CurationType.create({
      name,
      icon,
      color: color || '#ffffff',
      abilities: abilities || 0,
    });

    return res.status(201).json(type);
  } catch (error) {
    logger.error('Error creating curation type:', error);
    return res.status(500).json({error: 'Internal server error'});
  }
});

// Update curation type
router.put('/types/:id', Auth.superAdminPassword(), async (req, res) => {
  try {
    const {id} = req.params;
    const {name, icon, color, abilities} = req.body;

    const type = await CurationType.findByPk(id);
    if (!type) {
      return res.status(404).json({error: 'Curation type not found'});
    }

    await type.update({
      name,
      icon,
      color,
      abilities,
    });

    return res.json(type);
  } catch (error) {
    logger.error('Error updating curation type:', error);
    return res.status(500).json({error: 'Internal server error'});
  }
});

// Delete curation type
router.delete('/types/:id', Auth.superAdminPassword(), async (req, res) => {
  try {
    const {id} = req.params;

    const type = await CurationType.findByPk(id);
    if (!type) {
      return res.status(404).json({error: 'Curation type not found'});
    }

    await type.destroy();
    return res.status(204).send();
  } catch (error) {
    logger.error('Error deleting curation type:', error);
    return res.status(500).json({error: 'Internal server error'});
  }
});

// Upload curation icon
router.post('/types/:id/icon', Auth.superAdminPassword(), upload.single('icon'), async (req, res) => {
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
router.delete('/types/:id/icon', Auth.superAdminPassword(), async (req, res) => {
  try {
    const {id} = req.params;

    const type = await CurationType.findByPk(id);
    if (!type) {
      return res.status(404).json({error: 'Curation type not found'});
    }

    // Clear the icon field
    await type.update({icon: null});

    return res.json({success: true, message: 'Icon removed successfully'});
  } catch (error) {
    logger.error('Error deleting curation icon:', error);
    return res.status(500).json({error: 'Failed to delete icon'});
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

    const include = [
      {
        model: CurationType,
        as: 'type',
      },
      {
        model: Level,
        as: 'level',
        where: search ? {
          [Op.or]: [
            {song: {[Op.like]: `%${search}%`}},
            {artist: {[Op.like]: `%${search}%`}},
            {creator: {[Op.like]: `%${search}%`}},
          ],
        } : undefined,
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

    const curations = await Curation.findAndCountAll({
      where,
      include,
      limit: Number(limit),
      offset,
      order: [['createdAt', 'DESC']],
    });

    return res.json({
      curations: curations.rows,
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
router.post('/', Auth.superAdmin(), async (req, res) => {
  try {
    const {levelId, typeId, shortDescription, description, previewLink, customCSS, customColor} = req.body;
    const assignedBy = req.user?.id || 'unknown';

    if (!levelId || !typeId) {
      return res.status(400).json({error: 'Level ID and Type ID are required'});
    }

    // Check if level exists
    const level = await Level.findByPk(levelId);
    if (!level) {
      return res.status(404).json({error: 'Level not found'});
    }

    // Check if type exists
    const type = await CurationType.findByPk(typeId);
    if (!type) {
      return res.status(404).json({error: 'Curation type not found'});
    }

    const curation = await Curation.create({
      levelId,
      typeId,
      shortDescription,
      description,
      previewLink,
      customCSS,
      customColor,
      assignedBy,
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

    return res.status(201).json({ curation: completeCuration });
  } catch (error) {
    logger.error('Error creating curation:', error);
    return res.status(500).json({error: 'Internal server error'});
  }
});

// Update curation
router.put('/:id([0-9]+)', Auth.superAdmin(), async (req, res) => {
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

    return res.json({ curation: completeCuration });
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

    return res.json(curation);
  } catch (error) {
    logger.error('Error fetching curation:', error);
    return res.status(500).json({error: 'Internal server error'});
  }
});

// Delete curation
router.delete('/:id([0-9]+)', Auth.superAdmin(), async (req, res) => {
  try {
    const {id} = req.params;

    const curation = await Curation.findByPk(id);
    if (!curation) {
      return res.status(404).json({error: 'Curation not found'});
    }

    await curation.destroy();
    return res.status(200).json({
      success: true,
      message: 'Curation deleted successfully',
    });
  } catch (error) {
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

    return res.json({
      schedules: schedules,
    });
  } catch (error) {
    logger.error('Error fetching curation schedules:', error);
    return res.status(500).json({error: 'Internal server error'});
  }
});

// Create curation schedule
router.post('/schedules', Auth.superAdmin(), async (req, res) => {
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

    const schedule = await CurationSchedule.create({
      curationId,
      weekStart: new Date(weekStart),
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

    return res.status(201).json(completeSchedule);
  } catch (error) {
    logger.error('Error creating curation schedule:', error);
    return res.status(500).json({error: 'Internal server error'});
  }
});

// Update curation schedule
router.put('/schedules/:id', Auth.superAdmin(), async (req, res) => {
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
router.delete('/schedules/:id', Auth.superAdmin(), async (req, res) => {
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
router.post('/:id([0-9]+)/thumbnail', Auth.superAdmin(), upload.single('thumbnail'), async (req, res) => {
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
router.delete('/:id([0-9]+)/thumbnail', Auth.superAdmin(), async (req, res) => {
  try {
    const {id} = req.params;

    const curation = await Curation.findByPk(id);
    if (!curation) {
      return res.status(404).json({error: 'Curation not found'});
    }

    // Check if there's a thumbnail to delete
    if (curation.previewLink && isCdnUrl(curation.previewLink)) {
      // Extract file ID from CDN URL
      console.log(curation)
      const fileId = getFileIdFromCdnUrl(curation.previewLink);
      console.log(fileId)
      
      if (fileId) {
        try {
          // Delete file from CDN
          logger.info(`Deleting thumbnail file ${fileId} from CDN`);
          await CdnService.deleteFile(fileId);
          logger.info(`Successfully deleted thumbnail file ${fileId} from CDN`);
        } catch (cdnError) {
          logger.error('Error deleting file from CDN:', cdnError);
          // Continue with database update even if CDN deletion fails
        }
      }
    }

    // Clear the preview link
    await curation.update({previewLink: null});

    return res.json({success: true, message: 'Thumbnail removed successfully'});
  } catch (error) {
    logger.error('Error deleting level thumbnail:', error);
    return res.status(500).json({error: 'Failed to delete thumbnail'});
  }
});

export default router;
