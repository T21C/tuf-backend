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
import {escapeForMySQL} from '../../../misc/utils/data/searchHelpers.js';
import {logger} from '../../services/LoggerService.js';
import EvidenceService from '../../services/EvidenceService.js';

const router: Router = Router();
const evidenceService = EvidenceService.getInstance();

const MAX_LIMIT = 200;

// Get public artist list (paginated, searchable)
router.get('/', Auth.addUserToRequest(), async (req: Request, res: Response) => {
  try {
    const {
      page = '1',
      limit = '50',
      search = '',
      sort = 'NAME_ASC',
    } = req.query;

    const offset = (parseInt(page as string) - 1) * parseInt(limit as string);
    const normalizedLimit = Math.max(1, Math.min(MAX_LIMIT, parseInt(limit as string)));

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
      ? {id: {[Op.in]: Array.from(artistIds)}}
      : {};

    const {count, rows} = await Artist.findAndCountAll({
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
          attributes: ['id', 'link', 'type']
        }
      ]
    });

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

// Get public artist detail page
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
          attributes: ['id', 'link', 'type']
        },
        {
          model: SongCredit,
          as: 'songCredits',
          include: [
            {
              model: Song,
              as: 'song',
              attributes: ['id', 'name', 'verificationState']
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

// Get evidence images (public read-only)
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
