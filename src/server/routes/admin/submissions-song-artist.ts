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
    return res.json({success: true});
  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error changing song:', error);
    return res.status(500).json({error: 'Failed to change song'});
  }
});

// Change artist selection
router.put('/levels/:id/artist', Auth.superAdmin(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  try {
    const {artistId, isNewRequest, artistName, requiresEvidence} = req.body;
    const submission = await LevelSubmission.findByPk(req.params.id, {
      include: [
        {
          model: LevelSubmissionArtistRequest,
          as: 'artistRequest'
        }
      ],
      transaction
    });

    if (!submission) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({error: 'Submission not found'});
    }

    // Delete existing artist request if exists
    if (submission.artistRequest) {
      await submission.artistRequest.destroy({transaction});
    }

    let newArtistRequestId: number | null = null;
    let finalArtistId: number | null = null;

    if (artistId) {
      // Use existing artist
      finalArtistId = parseInt(artistId);
      const artist = await Artist.findByPk(finalArtistId, {transaction});
      if (!artist) {
        await safeTransactionRollback(transaction);
        return res.status(404).json({error: 'Artist not found'});
      }
    } else if (isNewRequest && artistName) {
      // Create new artist request
      const artistRequest = await LevelSubmissionArtistRequest.create({
        submissionId: submission.id,
        artistName: artistName.trim(),
        isNewRequest: true,
        requiresEvidence: requiresEvidence || false
      }, {transaction});
      newArtistRequestId = artistRequest.id;
    }

    // Update submission
    await submission.update({
      artistId: finalArtistId,
      artistRequestId: newArtistRequestId,
      artist: artistId ? (await Artist.findByPk(artistId, {transaction}))?.name : artistName
    }, {transaction});

    await transaction.commit();
    return res.json({success: true});
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

export default router;
