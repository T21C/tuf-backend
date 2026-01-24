import {Router, Request, Response} from 'express';
import {Op} from 'sequelize';
import {Auth} from '../../middleware/auth.js';
import LevelSubmission from '../../../models/submissions/LevelSubmission.js';
import LevelSubmissionSongRequest from '../../../models/submissions/LevelSubmissionSongRequest.js';
import LevelSubmissionArtistRequest from '../../../models/submissions/LevelSubmissionArtistRequest.js';
import LevelSubmissionEvidence from '../../../models/submissions/LevelSubmissionEvidence.js';
import Song from '../../../models/songs/Song.js';
import Artist from '../../../models/artists/Artist.js';
import sequelize from '../../../config/db.js';
import {logger} from '../../services/LoggerService.js';
import {safeTransactionRollback} from '../../../misc/utils/Utility.js';
import SongService from '../../services/SongService.js';
import ArtistService from '../../services/ArtistService.js';
import EvidenceService from '../../services/EvidenceService.js';
import multer from 'multer';
import SongAlias from '../../../models/songs/SongAlias.js';
import ArtistAlias from '../../../models/artists/ArtistAlias.js';
import SongCredit from '../../../models/songs/SongCredit.js';

const router: Router = Router();
const songService = SongService.getInstance();
const artistService = ArtistService.getInstance();
const evidenceService = EvidenceService.getInstance();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB per file
  }
});

// Change song selection (similar to creator selection)
router.put('/levels/:id/song', Auth.superAdmin(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  try {
    const {songId, isNewRequest, songName, requiresEvidence} = req.body;
    const submission = await LevelSubmission.findByPk(req.params.id, {
      include: [
        {
          model: LevelSubmissionSongRequest,
          as: 'songRequest'
        }
      ],
      transaction
    });

    if (!submission) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({error: 'Submission not found'});
    }

    // Delete existing song request if exists
    if (submission.songRequest) {
      await submission.songRequest.destroy({transaction});
    }

    let newSongRequestId: number | null = null;
    let finalSongId: number | null = null;

    if (songId) {
      // Use existing song
      finalSongId = parseInt(songId);
      const song = await Song.findByPk(finalSongId, {transaction});
      if (!song) {
        await safeTransactionRollback(transaction);
        return res.status(404).json({error: 'Song not found'});
      }
    } else if (isNewRequest && songName) {
      // Create new song request
      const songRequest = await LevelSubmissionSongRequest.create({
        submissionId: submission.id,
        songName: songName.trim(),
        isNewRequest: true,
        requiresEvidence: requiresEvidence || false
      }, {transaction});
      newSongRequestId = songRequest.id;
    }

    // Update submission
    await submission.update({
      songId: finalSongId,
      songRequestId: newSongRequestId,
      song: songId ? (await Song.findByPk(songId, {transaction}))?.name : songName
    }, {transaction});

    await transaction.commit();

    // Fetch updated submission with all associations
    const updatedSubmission = await LevelSubmission.findByPk(req.params.id, {
      include: [
        {
          model: LevelSubmissionSongRequest,
          as: 'songRequest',
          include: [
            {
              model: Song,
              as: 'song',
              attributes: ['id', 'name', 'verificationState']
            }
          ]
        }
      ]
    });

    return res.json(updatedSubmission);
  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error changing song:', error);
    return res.status(500).json({error: 'Failed to change song'});
  }
});

// Change artist selection (updates a specific artist request by ID, or adds new one)
router.put('/levels/:id/artist', Auth.superAdmin(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  try {
    const {artistId, artistRequestId, isNewRequest, artistName, requiresEvidence} = req.body;
    const submission = await LevelSubmission.findByPk(req.params.id, {
      include: [
        {
          model: LevelSubmissionArtistRequest,
          as: 'artistRequests'
        },
        {
          model: Song,
          as: 'songObject'
        }
      ],
      transaction
    });

    if (!submission) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({error: 'Submission not found'});
    }

    // If an existing song is selected, artists are locked
    if (submission.songId && submission.songObject) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ 
        error: 'Cannot modify artists when an existing song is selected. Artists are automatically set from song credits.' 
      });
    }

    let finalArtistId: number | null = null;

    if (artistId) {
      // Use existing artist
      finalArtistId = parseInt(artistId);
      const artist = await Artist.findByPk(finalArtistId, {transaction});
      if (!artist) {
        await safeTransactionRollback(transaction);
        return res.status(404).json({error: 'Artist not found'});
      }

      // Update existing request if artistRequestId provided
      if (artistRequestId && submission.artistRequests) {
        const existingRequest = submission.artistRequests.find((req: any) => req.id === artistRequestId);
        if (existingRequest) {
          await existingRequest.update({
            artistId: finalArtistId,
            artistName: artist.name,
            isNewRequest: false,
            requiresEvidence: requiresEvidence || false
          }, {transaction});
        } else {
          await safeTransactionRollback(transaction);
          return res.status(404).json({error: 'Artist request not found'});
        }
      } else {
        // Add new artist request
        await LevelSubmissionArtistRequest.create({
          submissionId: submission.id,
          artistId: finalArtistId,
          artistName: artist.name,
          isNewRequest: false,
          requiresEvidence: requiresEvidence || false
        }, {transaction});
      }
    } else if (isNewRequest && artistName) {
      // Update existing request if artistRequestId provided
      if (artistRequestId && submission.artistRequests) {
        const existingRequest = submission.artistRequests.find((req: any) => req.id === artistRequestId);
        if (existingRequest) {
          await existingRequest.update({
            artistName: artistName.trim(),
            isNewRequest: true,
            requiresEvidence: requiresEvidence || false
          }, {transaction});
        } else {
          await safeTransactionRollback(transaction);
          return res.status(404).json({error: 'Artist request not found'});
        }
      } else {
        // Create new artist request
        await LevelSubmissionArtistRequest.create({
          submissionId: submission.id,
          artistName: artistName.trim(),
          isNewRequest: true,
          requiresEvidence: requiresEvidence || false
        }, {transaction});
      }
    }

    // Update submission with first artist for backward compatibility
    const firstRequest = submission.artistRequests?.[0];
    if (firstRequest && firstRequest.artistId) {
      await submission.update({
        artistId: firstRequest.artistId,
        artist: firstRequest.artistName || submission.artist
      }, {transaction});
    }

    await transaction.commit();

    // Fetch updated submission with all associations
    const updatedSubmission = await LevelSubmission.findByPk(req.params.id, {
      include: [
        {
          model: LevelSubmissionArtistRequest,
          as: 'artistRequests',
          include: [
            {
              model: Artist,
              as: 'artist',
              attributes: ['id', 'name', 'avatarUrl', 'verificationState']
            }
          ]
        }
      ]
    });

    return res.json(updatedSubmission);
  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error changing artist:', error);
    return res.status(500).json({error: 'Failed to change artist'});
  }
});

// Upload evidence images for submission (up to 10)
router.post('/levels/:id/evidence', Auth.superAdmin(), upload.array('evidence', 10), async (req: Request, res: Response) => {
  try {
    const {type, requestId} = req.body; // type: 'song' or 'artist'
    const files = req.files as Express.Multer.File[];

    if (!files || files.length === 0) {
      return res.status(400).json({error: 'No files uploaded'});
    }

    if (files.length > 10) {
      return res.status(400).json({error: 'Maximum 10 evidence images allowed'});
    }

    const evidences = await evidenceService.uploadEvidenceImages(
      parseInt(req.params.id),
      files,
      type as 'song' | 'artist',
      requestId ? parseInt(requestId) : null
    );

    return res.json({evidences});
  } catch (error) {
    logger.error('Error uploading evidence:', error);
    return res.status(500).json({error: 'Failed to upload evidence'});
  }
});

// Delete evidence image
router.delete('/levels/:id/evidence/:evidenceId', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    await evidenceService.deleteEvidenceImage(parseInt(req.params.evidenceId));
    return res.json({success: true});
  } catch (error) {
    logger.error('Error deleting evidence:', error);
    return res.status(500).json({error: 'Failed to delete evidence'});
  }
});

// Get evidence for submission
router.get('/levels/:id/evidence', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    const evidences = await evidenceService.getEvidenceForSubmission(parseInt(req.params.id));
    return res.json(evidences);
  } catch (error) {
    logger.error('Error fetching evidence:', error);
    return res.status(500).json({error: 'Failed to fetch evidence'});
  }
});

// Assign existing song to submission request
router.put('/levels/:id/assign-song', Auth.superAdmin(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  try {
    const { id } = req.params;
    const { songId } = req.body;

    if (!songId) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'Song ID is required' });
    }

    const submission = await LevelSubmission.findOne({
      where: { id },
      include: [
        {
          model: LevelSubmissionSongRequest,
          as: 'songRequest'
        }
      ],
      transaction
    });

    if (!submission) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({ error: 'Submission not found' });
    }

    const song = await Song.findByPk(songId, {
      include: [
        {
          model: SongCredit,
          as: 'credits',
          include: [
            {
              model: Artist,
              as: 'artist',
              attributes: ['id', 'name']
            }
          ],
          required: false
        }
      ],
      transaction
    });
    
    if (!song) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({ error: 'Song not found' });
    }

    // Update or create song request
    if (submission.songRequest) {
      await submission.songRequest.update({
        songId: song.id,
        songName: song.name,
        isNewRequest: false,
        requiresEvidence: false
      }, { transaction });
    } else {
      await LevelSubmissionSongRequest.create({
        submissionId: submission.id,
        songId: song.id,
        songName: song.name,
        isNewRequest: false,
        requiresEvidence: false
      }, { transaction });
    }

    // Delete existing artist requests
    await LevelSubmissionArtistRequest.destroy({
      where: { submissionId: submission.id },
      transaction
    });

    // Auto-populate artist requests from song credits
    if (song.credits && song.credits.length > 0) {
      const artistRequests = song.credits.map((credit: any) => ({
        submissionId: submission.id,
        artistId: credit.artist?.id || null,
        artistName: credit.artist?.name || null,
        isNewRequest: false,
        requiresEvidence: false
      })).filter((req: any) => req.artistId !== null);
      
      if (artistRequests.length > 0) {
        await LevelSubmissionArtistRequest.bulkCreate(artistRequests, { transaction });
      }
    }

    // Update submission
    await submission.update({
      songId: song.id,
      song: song.name
    }, { transaction });

    await transaction.commit();
    
    // Fetch updated submission with all associations
    const updatedSubmission = await LevelSubmission.findByPk(submission.id, {
      include: [
        {
          model: LevelSubmissionSongRequest,
          as: 'songRequest',
          include: [
            {
              model: Song,
              as: 'song',
              attributes: ['id', 'name', 'verificationState']
            }
          ]
        },
        {
          model: LevelSubmissionArtistRequest,
          as: 'artistRequests',
          include: [
            {
              model: Artist,
              as: 'artist',
              attributes: ['id', 'name']
            }
          ]
        },
        {
          model: Song,
          as: 'songObject',
          include: [
            {
              model: SongCredit,
              as: 'credits',
              include: [
                {
                  model: Artist,
                  as: 'artist',
                  attributes: ['id', 'name']
                }
              ],
              required: false
            }
          ]
        }
      ]
    });

    return res.json(updatedSubmission);
  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error assigning song:', error);
    return res.status(500).json({ error: 'Failed to assign song' });
  }
});

// Assign existing artist to submission request (adds to array)
router.put('/levels/:id/assign-artist', Auth.superAdmin(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  try {
    const { id } = req.params;
    const { artistId } = req.body;

    if (!artistId) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'Artist ID is required' });
    }

    const submission = await LevelSubmission.findOne({
      where: { id },
      include: [
        {
          model: LevelSubmissionArtistRequest,
          as: 'artistRequests'
        },
        {
          model: Song,
          as: 'songObject',
          include: [
            {
              model: SongCredit,
              as: 'credits',
              include: [
                {
                  model: Artist,
                  as: 'artist',
                  attributes: ['id', 'name']
                }
              ],
              required: false
            }
          ]
        }
      ],
      transaction
    });

    if (!submission) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({ error: 'Submission not found' });
    }

    // If an existing song is selected, artists are locked and must match song credits
    if (submission.songId && submission.songObject) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ 
        error: 'Cannot modify artists when an existing song is selected. Artists are automatically set from song credits.' 
      });
    }

    const artist = await Artist.findByPk(artistId, { transaction });
    if (!artist) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({ error: 'Artist not found' });
    }

    // Check if artist already exists in requests
    const existingRequest = submission.artistRequests?.find(
      (req: any) => req.artistId === artist.id
    );

    if (existingRequest) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'Artist already added to submission' });
    }

    // Add new artist request
    await LevelSubmissionArtistRequest.create({
      submissionId: submission.id,
      artistId: artist.id,
      artistName: artist.name,
      isNewRequest: false,
      requiresEvidence: false
    }, { transaction });

    // Update submission with first artist for backward compatibility
    if (!submission.artistId) {
      await submission.update({
        artistId: artist.id,
        artist: artist.name
      }, { transaction });
    }

    await transaction.commit();
    
    // Fetch updated submission
    const updatedSubmission = await LevelSubmission.findByPk(submission.id, {
      include: [
        {
          model: LevelSubmissionArtistRequest,
          as: 'artistRequests',
          include: [
            {
              model: Artist,
              as: 'artist',
              attributes: ['id', 'name']
            }
          ]
        }
      ]
    });

    return res.json(updatedSubmission);
  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error assigning artist:', error);
    return res.status(500).json({ error: 'Failed to assign artist' });
  }
});

// Create and assign song in one step
router.post('/levels/:id/songs', Auth.superAdmin(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  try {
    const { id } = req.params;
    const { name, aliases, songRequestId } = req.body;

    if (!name) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'Song name is required' });
    }

    const submission = await LevelSubmission.findOne({
      where: { id },
      include: [
        {
          model: LevelSubmissionSongRequest,
          as: 'songRequest'
        }
      ],
      transaction
    });

    if (!submission) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({ error: 'Submission not found' });
    }

    // Create or find song
    const [song] = await Song.findOrCreate({
      where: { name: name.trim() },
      defaults: {
        name: name.trim(),
        verificationState: 'unverified'
      },
      transaction
    });

    // Create song aliases if provided
    if (aliases && Array.isArray(aliases) && aliases.length > 0) {
      const aliasRecords = aliases.map((alias: string) => ({
        songId: song.id,
        alias: alias.trim(),
      }));

      await SongAlias.bulkCreate(aliasRecords, {
        transaction,
        ignoreDuplicates: true
      });
    }

    // Update song request if exists
    if (songRequestId && submission.songRequest) {
      await submission.songRequest.update({
        songId: song.id,
        songName: song.name,
        isNewRequest: false,
        requiresEvidence: false
      }, { transaction });
    } else if (!submission.songRequest) {
      // Create new song request if doesn't exist
      await LevelSubmissionSongRequest.create({
        submissionId: submission.id,
        songId: song.id,
        songName: song.name,
        isNewRequest: false,
        requiresEvidence: false
      }, { transaction });
    }

    // Update submission
    await submission.update({
      songId: song.id,
      song: song.name
    }, { transaction });

    await transaction.commit();

    // Fetch updated submission
    const updatedSubmission = await LevelSubmission.findOne({
      where: { id },
      include: [
        {
          model: LevelSubmissionSongRequest,
          as: 'songRequest',
          include: [
            {
              model: Song,
              as: 'song',
              include: [
                {
                  model: SongAlias,
                  as: 'aliases',
                  attributes: ['id', 'alias']
                }
              ]
            }
          ]
        }
      ]
    });

    return res.json(updatedSubmission);
  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error creating and assigning song:', error);
    return res.status(500).json({ error: 'Failed to create and assign song' });
  }
});

// Create and assign artist in one step (adds to array)
router.post('/levels/:id/artists', Auth.superAdmin(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  try {
    const { id } = req.params;
    const { name, aliases, artistRequestId } = req.body;

    if (!name) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'Artist name is required' });
    }

    const submission = await LevelSubmission.findOne({
      where: { id },
      include: [
        {
          model: LevelSubmissionArtistRequest,
          as: 'artistRequests'
        },
        {
          model: Song,
          as: 'songObject'
        }
      ],
      transaction
    });

    if (!submission) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({ error: 'Submission not found' });
    }

    // If an existing song is selected, artists are locked
    if (submission.songId && submission.songObject) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ 
        error: 'Cannot modify artists when an existing song is selected. Artists are automatically set from song credits.' 
      });
    }

    // Create or find artist
    const [artist] = await Artist.findOrCreate({
      where: { name: name.trim() },
      defaults: {
        name: name.trim(),
        verificationState: 'unverified'
      },
      transaction
    });

    // Create artist aliases if provided
    if (aliases && Array.isArray(aliases) && aliases.length > 0) {
      const aliasRecords = aliases.map((alias: string) => ({
        artistId: artist.id,
        alias: alias.trim(),
      }));

      await ArtistAlias.bulkCreate(aliasRecords, {
        transaction,
        ignoreDuplicates: true
      });
    }

    // Check if artist already exists in requests
    const existingRequest = submission.artistRequests?.find(
      (req: any) => req.artistId === artist.id
    );

    if (existingRequest) {
      // Update existing request if artistRequestId matches
      if (artistRequestId && existingRequest.id === artistRequestId) {
        await existingRequest.update({
          artistId: artist.id,
          artistName: artist.name,
          isNewRequest: false,
          requiresEvidence: false
        }, { transaction });
      } else {
        await safeTransactionRollback(transaction);
        return res.status(400).json({ error: 'Artist already added to submission' });
      }
    } else {
      // Create new artist request
      await LevelSubmissionArtistRequest.create({
        submissionId: submission.id,
        artistId: artist.id,
        artistName: artist.name,
        isNewRequest: false,
        requiresEvidence: false
      }, { transaction });
    }

    // Update submission with first artist for backward compatibility
    if (!submission.artistId) {
      await submission.update({
        artistId: artist.id,
        artist: artist.name
      }, { transaction });
    }

    await transaction.commit();

    // Fetch updated submission
    const updatedSubmission = await LevelSubmission.findByPk(submission.id, {
      include: [
        {
          model: LevelSubmissionArtistRequest,
          as: 'artistRequests',
          include: [
            {
              model: Artist,
              as: 'artist',
              attributes: ['id', 'name']
            }
          ]
        }
      ]
    });

    return res.json(updatedSubmission);
  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error creating and assigning artist:', error);
    return res.status(500).json({ error: 'Failed to create and assign artist' });
  }
});

// Add a new song request
router.post('/levels/:id/song-requests', Auth.superAdmin(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  try {
    const { id } = req.params;

    const submission = await LevelSubmission.findOne({
      where: { id },
      include: [
        {
          model: LevelSubmissionSongRequest,
          as: 'songRequest'
        }
      ],
      transaction
    });

    if (!submission) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({ error: 'Submission not found' });
    }

    // Delete existing song request if exists
    if (submission.songRequest) {
      await submission.songRequest.destroy({ transaction });
    }

    // Create a new song request with placeholder name
    const placeholderName = submission.song || 'New Song';
    await LevelSubmissionSongRequest.create({
      submissionId: parseInt(id),
      songName: placeholderName,
      isNewRequest: true,
      requiresEvidence: false
    }, { transaction });

    // Update submission to clear songId
    await submission.update({
      songId: null,
      songRequestId: null
    }, { transaction });

    await transaction.commit();

    // Fetch updated submission
    const updatedSubmission = await LevelSubmission.findOne({
      where: { id },
      include: [
        {
          model: LevelSubmissionSongRequest,
          as: 'songRequest'
        }
      ]
    });

    return res.json(updatedSubmission);
  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error creating song request:', error);
    return res.status(500).json({ error: 'Failed to create song request' });
  }
});

// Add a new artist request
router.post('/levels/:id/artist-requests', Auth.superAdmin(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  try {
    const { id } = req.params;

    const submission = await LevelSubmission.findOne({
      where: { id },
      include: [
        {
          model: LevelSubmissionArtistRequest,
          as: 'artistRequests'
        },
        {
          model: Song,
          as: 'songObject'
        }
      ],
      transaction
    });

    if (!submission) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({ error: 'Submission not found' });
    }

    // If an existing song is selected, artists are locked
    if (submission.songId && submission.songObject) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ 
        error: 'Cannot add artist requests when an existing song is selected. Artists are automatically set from song credits.' 
      });
    }

    // Create a new artist request with placeholder name
    const placeholderName = submission.artist || 'New Artist';
    await LevelSubmissionArtistRequest.create({
      submissionId: parseInt(id),
      artistName: placeholderName,
      isNewRequest: true,
      requiresEvidence: false
    }, { transaction });

    // Update submission to clear artistId if no artists remain
    if (!submission.artistRequests || submission.artistRequests.length === 0) {
      await submission.update({
        artistId: null
      }, { transaction });
    }

    await transaction.commit();

    // Fetch updated submission
    const updatedSubmission = await LevelSubmission.findByPk(submission.id, {
      include: [
        {
          model: LevelSubmissionArtistRequest,
          as: 'artistRequests'
        }
      ]
    });

    return res.json(updatedSubmission);
  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error creating artist request:', error);
    return res.status(500).json({ error: 'Failed to create artist request' });
  }
});

// Delete an artist request
router.delete('/levels/:id/artist-requests/:requestId', Auth.superAdmin(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  try {
    const { id, requestId } = req.params;

    const submission = await LevelSubmission.findOne({
      where: { id },
      include: [
        {
          model: Song,
          as: 'songObject'
        }
      ],
      transaction
    });

    if (!submission) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({ error: 'Submission not found' });
    }

    // If an existing song is selected, artists are locked
    if (submission.songId && submission.songObject) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ 
        error: 'Cannot remove artist requests when an existing song is selected. Artists are automatically set from song credits.' 
      });
    }

    const artistRequest = await LevelSubmissionArtistRequest.findOne({
      where: {
        id: requestId,
        submissionId: id
      },
      transaction
    });

    if (!artistRequest) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({ error: 'Artist request not found' });
    }

    await artistRequest.destroy({ transaction });

    // Update submission artistId if this was the first artist
    const remainingRequests = await LevelSubmissionArtistRequest.findAll({
      where: { submissionId: id },
      transaction
    });

    if (remainingRequests.length === 0) {
      await submission.update({
        artistId: null
      }, { transaction });
    } else if (submission.artistId === artistRequest.artistId) {
      // Update to first remaining artist
      const firstRequest = remainingRequests[0];
      if (firstRequest.artistId) {
        await submission.update({
          artistId: firstRequest.artistId,
          artist: firstRequest.artistName || submission.artist
        }, { transaction });
      }
    }

    await transaction.commit();

    // Fetch updated submission
    const updatedSubmission = await LevelSubmission.findByPk(submission.id, {
      include: [
        {
          model: LevelSubmissionArtistRequest,
          as: 'artistRequests',
          include: [
            {
              model: Artist,
              as: 'artist',
              attributes: ['id', 'name']
            }
          ]
        }
      ]
    });

    return res.json(updatedSubmission);
  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error deleting artist request:', error);
    return res.status(500).json({ error: 'Failed to delete artist request' });
  }
});

export default router;
