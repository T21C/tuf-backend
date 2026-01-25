import {Router, Request, Response} from 'express';
import {Op} from 'sequelize';
import {Auth} from '../../middleware/auth.js';
import Artist from '../../../models/artists/Artist.js';
import ArtistAlias from '../../../models/artists/ArtistAlias.js';
import ArtistLink from '../../../models/artists/ArtistLink.js';
import ArtistEvidence from '../../../models/artists/ArtistEvidence.js';
import SongCredit from '../../../models/songs/SongCredit.js';
import Song from '../../../models/songs/Song.js';
import Level from '../../../models/levels/Level.js';
import sequelize from '../../../config/db.js';
import {escapeForMySQL} from '../../../misc/utils/data/searchHelpers.js';
import {logger} from '../../services/LoggerService.js';
import {safeTransactionRollback, isCdnUrl, getFileIdFromCdnUrl} from '../../../misc/utils/Utility.js';
import ArtistService from '../../services/ArtistService.js';
import EvidenceService from '../../services/EvidenceService.js';
import cdnServiceInstance, { CdnError } from '../../services/CdnService.js';
import multer from 'multer';

const router: Router = Router();
const artistService = ArtistService.getInstance();
const evidenceService = EvidenceService.getInstance();

const MAX_LIMIT = 200;

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB
  }
});

// Get all artists with pagination, search, filters
router.get('/', Auth.addUserToRequest(), async (req: Request, res: Response) => {
  try {
    const {
      page = '1',
      limit = '100',
      search = '',
      verificationState,
      sort = 'NAME_ASC',
    } = req.query;

    const offset = (parseInt(page as string) - 1) * parseInt(limit as string);
    const normalizedLimit = Math.max(1, Math.min(MAX_LIMIT, parseInt(limit as string)));

    const where: any = {};
    if (verificationState && typeof verificationState === 'string') {
      where.verificationState = verificationState;
    }

    const escapedSearch = escapeForMySQL(search as string);
    
    // Build order clause
    let order: any[] = [['name', 'ASC']];
    switch (sort) {
      case 'NAME_DESC':
        order = [['name', 'DESC']];
        break;
      case 'ID_ASC':
        order = [['id', 'ASC']];
        break;
      case 'ID_DESC':
        order = [['id', 'DESC']];
        break;
    }

    // Search by name or aliases
    const artistsByName = await Artist.findAll({
      where: {
        ...where,
        name: {[Op.like]: `%${escapedSearch}%`}
      },
      attributes: ['id'],
    });

    const artistsByAlias = await ArtistAlias.findAll({
      where: {alias: {[Op.like]: `%${escapedSearch}%`}},
      attributes: ['artistId'],
    });

    const artistIds: Set<number> = new Set(artistsByName.map(artist => artist.id));
    artistsByAlias.forEach(alias => artistIds.add(alias.artistId));

    const finalWhere = artistIds.size > 0
      ? {...where, id: {[Op.in]: Array.from(artistIds)}}
      : where;

    const {count, rows} = Object.keys(finalWhere).length > 0 ? await Artist.findAndCountAll({
      where: finalWhere,
      limit: normalizedLimit,
      offset,
      order,
      include: [
        {
          model: ArtistAlias,
          as: 'aliases',
          attributes: ['id', 'alias']
        },
        {
          model: ArtistLink,
          as: 'links',
          attributes: ['id', 'link']
        },
        {
          model: ArtistEvidence,
          as: 'evidences',
          attributes: ['id', 'link']
        }
      ]
    }): {count: 0, rows: []};

    return res.json({
      artists: rows,
      total: count,
      page: parseInt(page as string),
      limit: normalizedLimit,
      hasMore: offset + normalizedLimit < count
    });
  } catch (error) {
    logger.error('Error fetching artists:', error);
    return res.status(500).json({error: 'Failed to fetch artists'});
  }
});

// Get artist detail with aliases, links, evidence
router.get('/:id([0-9]{1,20})', Auth.addUserToRequest(), async (req: Request, res: Response) => {
  try {
    const artist = await Artist.findByPk(req.params.id, {
      include: [
        {
          model: ArtistAlias,
          as: 'aliases',
          attributes: ['id', 'alias']
        },
        {
          model: ArtistLink,
          as: 'links',
          attributes: ['id', 'link']
        },
        {
          model: ArtistEvidence,
          as: 'evidences',
          attributes: ['id', 'link']
        },
        {
          model: SongCredit,
          as: 'songCredits',
          include: [
            {
              model: Song,
              as: 'song',
              attributes: ['id', 'name']
            }
          ]
        },
        // Note: Levels no longer have direct artist relationship
        // To get levels for an artist, query through songs->songCredits->artists
      ]
    });

    if (!artist) {
      return res.status(404).json({error: 'Artist not found'});
    }

    return res.json(artist);
  } catch (error) {
    logger.error('Error fetching artist:', error);
    return res.status(500).json({error: 'Failed to fetch artist'});
  }
});

// Create new artist
router.post('/', Auth.superAdmin(), upload.single('avatar'), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  try {
    let {name, verificationState, aliases} = req.body;
    
    // Parse aliases if it's a JSON string (from FormData)
    if (typeof aliases === 'string') {
      try {
        aliases = JSON.parse(aliases);
      } catch (e) {
        // If parsing fails, treat as empty array
        aliases = [];
      }
    }

    if (!name || typeof name !== 'string') {
      await safeTransactionRollback(transaction);
      return res.status(400).json({error: 'Name is required'});
    }

    const trimmedName = name.trim();
    const normalizedName = trimmedName.toLowerCase();
    
    // Avatar must be uploaded as a file first (before checking duplicates)
    let cdnUrl: string | null = null;
    let uploadedFileId: string | null = null;
    
    if (req.file) {
      try {
        // Upload avatar to CDN first
        const uploadResult = await cdnServiceInstance.uploadImage(
          req.file.buffer,
          req.file.originalname,
          'PROFILE'
        );
        cdnUrl = uploadResult.urls.original;
        uploadedFileId = getFileIdFromCdnUrl(cdnUrl);
      } catch (error: any) {
        await safeTransactionRollback(transaction);
        if (error instanceof CdnError) {
          const statusCode = error.details?.status || (error.code === 'VALIDATION_ERROR' ? 400 : 500);
          logger.error('Error uploading avatar during creation:', error);
          return res.status(statusCode).json({
            error: error.message || 'Failed to upload avatar',
            code: error.code,
            details: error.details
          });
        }
        logger.error('Error uploading avatar:', error);
        return res.status(500).json({error: 'Failed to upload avatar'});
      }
    }

    // Check for case-insensitive duplicate using LOWER() function
    const existingArtist = await Artist.findOne({
      where: sequelize.where(
        sequelize.fn('LOWER', sequelize.col('name')),
        normalizedName
      ),
      transaction
    });

    if (existingArtist) {
      await safeTransactionRollback(transaction);
      
      // If we uploaded a file, delete it from CDN
      if (uploadedFileId && cdnUrl) {
        try {
          await cdnServiceInstance.deleteFile(uploadedFileId);
          logger.info(`Deleted uploaded avatar file ${uploadedFileId} due to duplicate artist name`);
        } catch (deleteError) {
          logger.error(`Failed to delete uploaded avatar file ${uploadedFileId} after duplicate check:`, deleteError);
        }
      }
      
      return res.status(400).json({
        error: `Artist with name "${existingArtist.name}" already exists`,
        code: 'DUPLICATE_ARTIST',
        existingArtistId: existingArtist.id
      });
    }

    try {
      // Create artist with CDN URL (if uploaded)
      const artist = await Artist.create({
        name: name.trim(),
        avatarUrl: cdnUrl || null,
        verificationState: verificationState || 'unverified'
      }, {transaction});

      // Add aliases if provided
      if (aliases && Array.isArray(aliases) && aliases.length > 0) {
        const uniqueAliases = [...new Set(aliases.map((a: any) => String(a).trim()).filter((a: string) => a))];
        if (uniqueAliases.length > 0) {
          await ArtistAlias.bulkCreate(
            uniqueAliases.map((alias: string) => ({
              artistId: artist.id,
              alias: alias.trim()
            })),
            {transaction}
          );
        }
      }

      await transaction.commit();
      
      // Fetch full artist with relations
      const createdArtist = await Artist.findByPk(artist.id, {
        include: [
          {
            model: ArtistAlias,
            as: 'aliases',
            attributes: ['id', 'alias']
          },
          {
            model: ArtistLink,
            as: 'links',
            attributes: ['id', 'link']
          },
          {
            model: ArtistEvidence,
            as: 'evidences',
            attributes: ['id', 'link', 'extraInfo']
          }
        ]
      });

      return res.json(createdArtist);
    } catch (error: any) {
      await safeTransactionRollback(transaction);
      
      // If artist creation failed and we uploaded a file, delete it from CDN
      if (uploadedFileId && cdnUrl) {
        try {
          await cdnServiceInstance.deleteFile(uploadedFileId);
          logger.info(`Deleted uploaded avatar file ${uploadedFileId} after failed artist creation`);
        } catch (deleteError) {
          logger.error(`Failed to delete uploaded avatar file ${uploadedFileId} after failed artist creation:`, deleteError);
        }
      }
      
      logger.error('Error creating artist:', error);
      return res.status(500).json({error: 'Failed to create artist'});
    }
  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error creating artist:', error);
    return res.status(500).json({error: 'Failed to create artist'});
  }
});

// Update artist
router.put('/:id([0-9]{1,20})', Auth.superAdmin(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  try {
    const artist = await Artist.findByPk(req.params.id, {transaction});
    if (!artist) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({error: 'Artist not found'});
    }

    const {name, verificationState} = req.body;

    if (name && typeof name === 'string') {
      artist.name = name.trim();
    }
    // Avatar can only be changed via upload/delete endpoints
    if (verificationState) {
      artist.verificationState = verificationState;
    }

    await artist.save({transaction});
    await transaction.commit();

    return res.json(artist);
  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error updating artist:', error);
    return res.status(500).json({error: 'Failed to update artist'});
  }
});

// Upload avatar image to CDN
router.post('/:id([0-9]{1,20})/avatar', Auth.superAdmin(), upload.single('avatar'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({error: 'No file uploaded'});
    }

    const cdnUrl = await artistService.uploadAvatar(
      parseInt(req.params.id),
      req.file
    );

    return res.json({avatarUrl: cdnUrl});
  } catch (error: any) {
    // Check if it's a CdnError and propagate the actual error details
    if (error instanceof CdnError) {
      const statusCode = error.details?.status || (error.code === 'VALIDATION_ERROR' ? 400 : 500);
      logger.error('Error uploading avatar:', error);
      return res.status(statusCode).json({
        error: error.message || 'Failed to upload avatar',
        code: error.code,
        details: error.details
      });
    }
    
    logger.error('Error uploading avatar:', error);
    return res.status(500).json({error: 'Failed to upload avatar'});
  }
});

// Delete avatar image
router.delete('/:id([0-9]{1,20})/avatar', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    await artistService.deleteAvatar(parseInt(req.params.id));
    return res.json({success: true});
  } catch (error) {
    logger.error('Error deleting avatar:', error);
    return res.status(500).json({error: 'Failed to delete avatar'});
  }
});

// Delete artist (with checks for levels using it)
router.delete('/:id([0-9]{1,20})', Auth.superAdmin(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  try {
    const artist = await Artist.findByPk(req.params.id, {transaction});
    if (!artist) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({error: 'Artist not found'});
    }

    // Check if artist is used in levels through song credits
    // Levels access artists through songs->songCredits->artists
    const songCredits = await SongCredit.findAll({
      where: {artistId: artist.id},
      attributes: ['songId'],
      transaction
    });

    if (songCredits.length > 0) {
      const songIds = songCredits.map(credit => credit.songId);
      const levelCount = await Level.count({
        where: {
          songId: {[Op.in]: songIds},
          isDeleted: false
        },
        transaction
      });

      if (levelCount > 0) {
        await safeTransactionRollback(transaction);
        return res.status(400).json({
          error: `Cannot delete artist: used in ${levelCount} level(s) through song credits`
        });
      }
    }

    // Delete avatar from CDN if exists
    if (artist.avatarUrl) {
      await artistService.deleteAvatar(artist.id);
    }

    await artist.destroy({transaction});
    await transaction.commit();

    return res.json({success: true});
  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error deleting artist:', error);
    return res.status(500).json({error: 'Failed to delete artist'});
  }
});

// Merge artist into another
router.post('/:id([0-9]{1,20})/merge', Auth.superAdmin(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  try {
    const {targetId} = req.body;
    if (!targetId) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({error: 'Target ID is required'});
    }

    await artistService.mergeArtists(parseInt(req.params.id), parseInt(targetId));
    await transaction.commit();

    return res.json({success: true});
  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error merging artists:', error);
    return res.status(500).json({error: 'Failed to merge artists'});
  }
});

// Check if artists exist before splitting
router.post('/:id([0-9]{1,20})/split/check', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    const {name1, name2} = req.body;
    
    if (!name1 || typeof name1 !== 'string') {
      return res.status(400).json({error: 'name1 is required'});
    }
    
    if (!name2 || typeof name2 !== 'string') {
      return res.status(400).json({error: 'name2 is required'});
    }

    const {existing1, existing2} = await artistService.checkExistingArtists(
      name1.trim(),
      name2.trim()
    );

    return res.json({
      existing1: existing1 ? {
        id: existing1.id,
        name: existing1.name,
        avatarUrl: existing1.avatarUrl
      } : null,
      existing2: existing2 ? {
        id: existing2.id,
        name: existing2.name,
        avatarUrl: existing2.avatarUrl
      } : null
    });
  } catch (error: any) {
    logger.error('Error checking existing artists:', error);
    return res.status(500).json({error: 'Failed to check existing artists'});
  }
});

// Split artist into two new artists
router.post('/:id([0-9]{1,20})/split', Auth.superAdmin(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  try {
    const {
      name1, 
      name2, 
      deleteOriginal = false,
      useExisting1 = false,
      useExisting2 = false
    } = req.body;
    
    if (!name1 || typeof name1 !== 'string') {
      await safeTransactionRollback(transaction);
      return res.status(400).json({error: 'name1 is required'});
    }
    
    if (!name2 || typeof name2 !== 'string') {
      await safeTransactionRollback(transaction);
      return res.status(400).json({error: 'name2 is required'});
    }

    const result = await artistService.splitArtist(
      parseInt(req.params.id),
      name1.trim(),
      name2.trim(),
      deleteOriginal === true || deleteOriginal === 'true',
      useExisting1 === true || useExisting1 === 'true',
      useExisting2 === true || useExisting2 === 'true',
      transaction
    );
    
    await transaction.commit();

    return res.json({
      success: true,
      artist1: result.artist1,
      artist2: result.artist2
    });
  } catch (error: any) {
    await safeTransactionRollback(transaction);
    logger.error('Error splitting artist:', error);
    const errorMessage = error.message || 'Failed to split artist';
    return res.status(500).json({error: errorMessage});
  }
});

// Add alias
router.post('/:id([0-9]{1,20})/aliases', Auth.superAdmin(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  try {
    const {alias} = req.body;
    if (!alias || typeof alias !== 'string') {
      await safeTransactionRollback(transaction);
      return res.status(400).json({error: 'Alias is required'});
    }

    const artistAlias = await ArtistAlias.create({
      artistId: parseInt(req.params.id),
      alias: alias.trim()
    }, {transaction});

    await transaction.commit();
    return res.json(artistAlias);
  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error adding alias:', error);
    return res.status(500).json({error: 'Failed to add alias'});
  }
});

// Delete alias
router.delete('/:id([0-9]{1,20})/aliases/:aliasId([0-9]{1,20})', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    const alias = await ArtistAlias.findOne({
      where: {
        id: req.params.aliasId,
        artistId: req.params.id
      }
    });

    if (!alias) {
      return res.status(404).json({error: 'Alias not found'});
    }

    await alias.destroy();
    return res.json({success: true});
  } catch (error) {
    logger.error('Error deleting alias:', error);
    return res.status(500).json({error: 'Failed to delete alias'});
  }
});

// Add link
router.post('/:id([0-9]{1,20})/links', Auth.superAdmin(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  try {
    const {link} = req.body;
    if (!link || typeof link !== 'string') {
      await safeTransactionRollback(transaction);
      return res.status(400).json({error: 'Link is required'});
    }

    const artistLink = await ArtistLink.create({
      artistId: parseInt(req.params.id),
      link: link.trim()
    }, {transaction});

    await transaction.commit();
    return res.json(artistLink);
  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error adding link:', error);
    return res.status(500).json({error: 'Failed to add link'});
  }
});

// Delete link
router.delete('/:id([0-9]{1,20})/links/:linkId([0-9]{1,20})', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    const link = await ArtistLink.findOne({
      where: {
        id: req.params.linkId,
        artistId: req.params.id
      }
    });

    if (!link) {
      return res.status(404).json({error: 'Link not found'});
    }

    await link.destroy();
    return res.json({success: true});
  } catch (error) {
    logger.error('Error deleting link:', error);
    return res.status(500).json({error: 'Failed to delete link'});
  }
});

// Add evidence (managers only)
router.post('/:id([0-9]{1,20})/evidences', Auth.superAdmin(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  try {
    const {link, extraInfo} = req.body;
    if (!link || typeof link !== 'string') {
      await safeTransactionRollback(transaction);
      return res.status(400).json({error: 'Link is required'});
    }

    const evidence = await evidenceService.addEvidenceToArtist(
      parseInt(req.params.id),
      link.trim(),
      extraInfo || null
    );

    await transaction.commit();
    return res.json(evidence);
  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error adding evidence:', error);
    return res.status(500).json({error: 'Failed to add evidence'});
  }
});

// Upload evidence images (managers only)
router.post('/:id([0-9]{1,20})/evidences/upload', Auth.superAdmin(), upload.array('evidence', 10), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  try {
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({error: 'No files uploaded'});
    }

    const evidences = [];

    for (const file of files) {
      // Upload to CDN
      const uploadResult = await cdnServiceInstance.uploadImage(
        file.buffer,
        file.originalname,
        'EVIDENCE'
      );

      const cdnUrl = uploadResult.urls.original;

      // Create evidence record
      const evidence = await evidenceService.addEvidenceToArtist(
        parseInt(req.params.id),
        cdnUrl
      );
      evidences.push(evidence);
    }

    await transaction.commit();
    return res.json({evidences});
  } catch (error: any) {
    await safeTransactionRollback(transaction);
    
    // Check if it's a CdnError and propagate the actual error details
    if (error instanceof CdnError) {
      const statusCode = error.details?.status || (error.code === 'VALIDATION_ERROR' ? 400 : 500);
      logger.error('Error uploading evidence:', error);
      return res.status(statusCode).json({
        error: error.message || 'Failed to upload evidence',
        code: error.code,
        details: error.details
      });
    }
    
    logger.error('Error uploading evidence:', error);
    return res.status(500).json({error: 'Failed to upload evidence'});
  }
});

// Update evidence (managers only) - only for external links
router.put('/:id([0-9]{1,20})/evidences/:evidenceId([0-9]{1,20})', Auth.superAdmin(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  try {
    const {link} = req.body;
    if (!link || typeof link !== 'string') {
      await safeTransactionRollback(transaction);
      return res.status(400).json({error: 'Link is required'});
    }

    const evidence = await evidenceService.updateArtistEvidence(
      parseInt(req.params.evidenceId),
      link.trim()
    );

    await transaction.commit();
    return res.json(evidence);
  } catch (error: any) {
    await safeTransactionRollback(transaction);
    logger.error('Error updating evidence:', error);
    if (error.message && error.message.includes('Cannot update CDN')) {
      return res.status(400).json({error: error.message});
    }
    return res.status(500).json({error: 'Failed to update evidence'});
  }
});

// Delete evidence
router.delete('/:id([0-9]{1,20})/evidences/:evidenceId([0-9]{1,20})', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    await evidenceService.deleteArtistEvidence(parseInt(req.params.evidenceId));
    return res.json({success: true});
  } catch (error) {
    logger.error('Error deleting evidence:', error);
    return res.status(500).json({error: 'Failed to delete evidence'});
  }
});

// Get evidence
router.get('/:id([0-9]{1,20})/evidences', Auth.addUserToRequest(), async (req: Request, res: Response) => {
  try {
    const evidences = await evidenceService.getEvidenceForArtist(parseInt(req.params.id));
    return res.json(evidences);
  } catch (error) {
    logger.error('Error fetching evidence:', error);
    return res.status(500).json({error: 'Failed to fetch evidence'});
  }
});

export default router;
