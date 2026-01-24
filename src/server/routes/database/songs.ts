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
import {escapeForMySQL} from '../../../misc/utils/data/searchHelpers.js';
import {logger} from '../../services/LoggerService.js';
import EvidenceService from '../../services/EvidenceService.js';

const router: Router = Router();
const evidenceService = EvidenceService.getInstance();

const MAX_LIMIT = 200;

// Get public song list (paginated, searchable)
router.get('/', Auth.addUserToRequest(), async (req: Request, res: Response) => {
  try {
    const {
      page = '1',
      limit = '50',
      search = '',
      artistId,
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
    let searchSongIds: Set<number> | null = null;
    
    if (escapedSearch.trim()) {
      const songsByName = await Song.findAll({
        where: {
          name: {[Op.like]: `%${escapedSearch}%`}
        },
        attributes: ['id'],
      });

      const songsByAlias = await SongAlias.findAll({
        where: {alias: {[Op.like]: `%${escapedSearch}%`}},
        attributes: ['songId'],
      });

      searchSongIds = new Set(songsByName.map(song => song.id));
      songsByAlias.forEach(alias => searchSongIds!.add(alias.songId));
    }

    // Filter by artist(s) if provided - supports comma-separated IDs like "51,76"
    let artistSongIds: number[] | null = null;
    if (artistId) {
      // Parse comma-separated artist IDs
      const artistIds = (artistId as string)
        .split(',')
        .map(id => parseInt(id.trim()))
        .filter(id => !isNaN(id) && id > 0);
      
      if (artistIds.length > 0) {
        if (artistIds.length === 1) {
          // Single artist: simple query
          const credits = await SongCredit.findAll({
            where: {artistId: artistIds[0]},
            attributes: ['songId']
          });
          artistSongIds = credits.map(c => c.songId);
        } else {
          // Multiple artists: find songs that have ALL specified artists
          // Get all song IDs that have credits for any of the artists
          const allCredits = await SongCredit.findAll({
            where: {artistId: {[Op.in]: artistIds}},
            attributes: ['songId', 'artistId']
          });
          
          // Group by songId and check if each song has all required artists
          const songArtistMap = new Map<number, Set<number>>();
          allCredits.forEach(credit => {
            if (!songArtistMap.has(credit.songId)) {
              songArtistMap.set(credit.songId, new Set());
            }
            songArtistMap.get(credit.songId)!.add(credit.artistId);
          });
          
          // Filter to only songs that have ALL the specified artists
          artistSongIds = Array.from(songArtistMap.entries())
            .filter(([songId, artistSet]) => {
              // Check if this song has all required artists
              return artistIds.every(id => artistSet.has(id));
            })
            .map(([songId]) => songId);
        }
      }
    }

    // Build final where clause
    const finalWhere: any = {};
    
    // Combine search and artist filters
    if (searchSongIds !== null && artistSongIds !== null) {
      // Both search and artist filter: intersect the results
      const intersection = Array.from(searchSongIds).filter(id => artistSongIds!.includes(id));
      finalWhere.id = {[Op.in]: intersection}; // Empty array if no matches
    } else if (searchSongIds !== null) {
      // Only search filter
      finalWhere.id = {[Op.in]: Array.from(searchSongIds)}; // Empty array if no matches
    } else if (artistSongIds !== null) {
      // Only artist filter
      finalWhere.id = {[Op.in]: artistSongIds}; // Empty array if no matches
    }
    // If neither search nor artistId, finalWhere remains {} (return all songs)

    
    const {count, rows} = Object.keys(finalWhere).length > 0 ? await Song.findAndCountAll({
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
    }): {count: 0, rows: []};

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

// Get public song detail page
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
              attributes: ['id', 'name', 'avatarUrl', 'verificationState']
            }
          ]
        },
        {
          model: Level,
          as: 'levels',
          attributes: ['id', 'song', 'artist'],
          where: {
            isDeleted: false,
            isHidden: false
          },
          required: false,
          limit: 20
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

// Get evidence images (public read-only)
router.get('/:id([0-9]{1,20})/evidences', Auth.addUserToRequest(), async (req: Request, res: Response) => {
  try {
    const evidences = await evidenceService.getEvidenceForSong(parseInt(req.params.id));
    return res.json(evidences);
  } catch (error) {
    logger.error('Error fetching evidence:', error);
    return res.status(500).json({error: 'Failed to fetch evidence'});
  }
});

export default router;
