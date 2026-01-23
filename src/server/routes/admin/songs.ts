import {Router, Request, Response} from 'express';
import {Op} from 'sequelize';
import {Auth} from '../../middleware/auth.js';
import Song from '../../../models/songs/Song.js';
import SongAlias from '../../../models/songs/SongAlias.js';
import SongLink from '../../../models/songs/SongLink.js';
import SongEvidence from '../../../models/songs/SongEvidence.js';
import SongCredit from '../../../models/songs/SongCredit.js';
import Artist from '../../../models/artists/Artist.js';
import Level from '../../../models/levels/Level.js';
import sequelize from '../../../config/db.js';
import {escapeForMySQL} from '../../../misc/utils/data/searchHelpers.js';
import {logger} from '../../services/LoggerService.js';
import {safeTransactionRollback} from '../../../misc/utils/Utility.js';
import SongService from '../../services/SongService.js';
import EvidenceService from '../../services/EvidenceService.js';
import cdnServiceInstance, { CdnError } from '../../services/CdnService.js';
import multer from 'multer';

const router: Router = Router();
const songService = SongService.getInstance();
const evidenceService = EvidenceService.getInstance();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB
  }
});

const MAX_LIMIT = 200;

// Get all songs with pagination, search, filters
router.get('/', Auth.addUserToRequest(), async (req: Request, res: Response) => {
  try {
    const {
      page = '1',
      limit = '100',
      search = '',
      verificationState,
      artistId,
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
    const songsByName = await Song.findAll({
      where: {
        ...where,
        name: {[Op.like]: `%${escapedSearch}%`}
      },
      attributes: ['id'],
    });

    const songsByAlias = await SongAlias.findAll({
      where: {alias: {[Op.like]: `%${escapedSearch}%`}},
      attributes: ['songId'],
    });

    const songIds: Set<number> = new Set(songsByName.map(song => song.id));
    songsByAlias.forEach(alias => songIds.add(alias.songId));

    const finalWhere: any = songIds.size > 0
      ? {...where, id: {[Op.in]: Array.from(songIds)}}
      : where;

    // Filter by artist if provided
    if (artistId) {
      const credits = await SongCredit.findAll({
        where: {artistId: parseInt(artistId as string)},
        attributes: ['songId']
      });
      const artistSongIds = credits.map(c => c.songId);
      if (artistSongIds.length > 0) {
        finalWhere.id = finalWhere.id
          ? {[Op.and]: [finalWhere.id, {[Op.in]: artistSongIds}]}
          : {[Op.in]: artistSongIds};
      } else {
        finalWhere.id = {[Op.in]: []}; // No songs found
      }
    }

    const {count, rows} = await Song.findAndCountAll({
      where: finalWhere,
      limit: normalizedLimit,
      offset,
      order,
      include: [
        {
          model: SongAlias,
          as: 'aliases',
          attributes: ['id', 'alias']
        },
        {
          model: SongEvidence,
          as: 'evidences',
          attributes: ['id', 'link', 'type']
        },
        {
          model: SongCredit,
          as: 'credits',
          include: [
            {
              model: Artist,
              as: 'artist',
              attributes: ['id', 'name', 'avatarUrl']
            }
          ]
        }
      ]
    });

    return res.json({
      songs: rows,
      total: count,
      page: parseInt(page as string),
      limit: normalizedLimit,
      hasMore: offset + normalizedLimit < count
    });
  } catch (error) {
    logger.error('Error fetching songs:', error);
    return res.status(500).json({error: 'Failed to fetch songs'});
  }
});

// Get song detail with aliases, links, credits
router.get('/:id([0-9]{1,20})', Auth.addUserToRequest(), async (req: Request, res: Response) => {
  try {
    const song = await Song.findByPk(req.params.id, {
      include: [
        {
          model: SongAlias,
          as: 'aliases',
          attributes: ['id', 'alias']
        },
        {
          model: SongLink,
          as: 'links',
          attributes: ['id', 'link']
        },
        {
          model: SongEvidence,
          as: 'evidences',
          attributes: ['id', 'link', 'type']
        },
        {
          model: SongCredit,
          as: 'credits',
          include: [
            {
              model: Artist,
              as: 'artist',
              attributes: ['id', 'name', 'avatarUrl']
            }
          ]
        },
        {
          model: Level,
          as: 'levels',
          attributes: ['id', 'song', 'artist'],
          limit: 10
        }
      ]
    });

    if (!song) {
      return res.status(404).json({error: 'Song not found'});
    }

    return res.json(song);
  } catch (error) {
    logger.error('Error fetching song:', error);
    return res.status(500).json({error: 'Failed to fetch song'});
  }
});

// Create new song
router.post('/', Auth.superAdmin(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  try {
    const {name, verificationState, aliases} = req.body;

    if (!name || typeof name !== 'string') {
      await safeTransactionRollback(transaction);
      return res.status(400).json({error: 'Name is required'});
    }

    const song = await Song.create({
      name: name.trim(),
      verificationState: verificationState || 'unverified'
    }, {transaction});

    // Add aliases if provided
    if (aliases && Array.isArray(aliases) && aliases.length > 0) {
      const uniqueAliases = [...new Set(aliases.map((a: string) => a.trim()).filter((a: string) => a))];
      if (uniqueAliases.length > 0) {
        await SongAlias.bulkCreate(
          uniqueAliases.map(alias => ({
            songId: song.id,
            alias: alias.trim()
          })),
          {transaction}
        );
      }
    }

    await transaction.commit();
    return res.json(song);
  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error creating song:', error);
    return res.status(500).json({error: 'Failed to create song'});
  }
});

// Update song
router.put('/:id([0-9]{1,20})', Auth.superAdmin(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  try {
    const song = await Song.findByPk(req.params.id, {transaction});
    if (!song) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({error: 'Song not found'});
    }

    const {name, verificationState} = req.body;

    if (name && typeof name === 'string') {
      song.name = name.trim();
    }
    if (verificationState) {
      song.verificationState = verificationState;
    }

    await song.save({transaction});
    await transaction.commit();

    return res.json(song);
  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error updating song:', error);
    return res.status(500).json({error: 'Failed to update song'});
  }
});

// Delete song (with checks)
router.delete('/:id([0-9]{1,20})', Auth.superAdmin(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  try {
    const song = await Song.findByPk(req.params.id, {transaction});
    if (!song) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({error: 'Song not found'});
    }

    // Check if song is used in levels
    const levelCount = await Level.count({
      where: {songId: song.id},
      transaction
    });

    if (levelCount > 0) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({
        error: `Cannot delete song: used in ${levelCount} level(s)`
      });
    }

    await song.destroy({transaction});
    await transaction.commit();

    return res.json({success: true});
  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error deleting song:', error);
    return res.status(500).json({error: 'Failed to delete song'});
  }
});

// Merge song into another
router.post('/:id([0-9]{1,20})/merge', Auth.superAdmin(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  try {
    const {targetId} = req.body;
    if (!targetId) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({error: 'Target ID is required'});
    }

    await songService.mergeSongs(parseInt(req.params.id), parseInt(targetId));
    await transaction.commit();

    return res.json({success: true});
  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error merging songs:', error);
    return res.status(500).json({error: 'Failed to merge songs'});
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

    const songAlias = await SongAlias.create({
      songId: parseInt(req.params.id),
      alias: alias.trim()
    }, {transaction});

    await transaction.commit();
    return res.json(songAlias);
  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error adding alias:', error);
    return res.status(500).json({error: 'Failed to add alias'});
  }
});

// Delete alias
router.delete('/:id([0-9]{1,20})/aliases/:aliasId([0-9]{1,20})', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    const alias = await SongAlias.findOne({
      where: {
        id: req.params.aliasId,
        songId: req.params.id
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

    const songLink = await SongLink.create({
      songId: parseInt(req.params.id),
      link: link.trim()
    }, {transaction});

    await transaction.commit();
    return res.json(songLink);
  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error adding link:', error);
    return res.status(500).json({error: 'Failed to add link'});
  }
});

// Delete link
router.delete('/:id([0-9]{1,20})/links/:linkId([0-9]{1,20})', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    const link = await SongLink.findOne({
      where: {
        id: req.params.linkId,
        songId: req.params.id
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
    const {link, type = 'other'} = req.body;
    if (!link || typeof link !== 'string') {
      await safeTransactionRollback(transaction);
      return res.status(400).json({error: 'Link is required'});
    }

    const evidence = await evidenceService.addEvidenceToSong(
      parseInt(req.params.id),
      link.trim(),
      type
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

    const {type = 'other'} = req.body;
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
      const evidence = await evidenceService.addEvidenceToSong(
        parseInt(req.params.id),
        cdnUrl,
        type as 'official' | 'music_platform' | 'video' | 'other'
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

// Delete evidence
router.delete('/:id([0-9]{1,20})/evidences/:evidenceId([0-9]{1,20})', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    await evidenceService.deleteSongEvidence(parseInt(req.params.evidenceId));
    return res.json({success: true});
  } catch (error) {
    logger.error('Error deleting evidence:', error);
    return res.status(500).json({error: 'Failed to delete evidence'});
  }
});

// Get evidence
router.get('/:id([0-9]{1,20})/evidences', Auth.addUserToRequest(), async (req: Request, res: Response) => {
  try {
    const evidences = await evidenceService.getEvidenceForSong(parseInt(req.params.id));
    return res.json(evidences);
  } catch (error) {
    logger.error('Error fetching evidence:', error);
    return res.status(500).json({error: 'Failed to fetch evidence'});
  }
});

// Add artist credit
router.post('/:id([0-9]{1,20})/credits', Auth.superAdmin(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  try {
    const {artistId, role} = req.body;
    if (!artistId) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({error: 'Artist ID is required'});
    }

    const credit = await songService.addArtistCredit(
      parseInt(req.params.id),
      parseInt(artistId),
      role || null
    );

    await transaction.commit();
    return res.json(credit);
  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error adding credit:', error);
    return res.status(500).json({error: 'Failed to add credit'});
  }
});

// Remove credit
router.delete('/:id([0-9]{1,20})/credits/:creditId([0-9]{1,20})', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    const credit = await SongCredit.findOne({
      where: {
        id: req.params.creditId,
        songId: req.params.id
      }
    });

    if (!credit) {
      return res.status(404).json({error: 'Credit not found'});
    }

    await credit.destroy();
    return res.json({success: true});
  } catch (error) {
    logger.error('Error deleting credit:', error);
    return res.status(500).json({error: 'Failed to delete credit'});
  }
});

export default router;
