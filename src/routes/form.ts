import express, {Request, Response, Router} from 'express';
import {verifyAccessToken} from '../utils/authHelpers.js';
import {emailBanList} from '../config/constants.js';
import LevelSubmission from '../models/LevelSubmission';
import {
  PassSubmission,
  PassSubmissionJudgements,
  PassSubmissionFlags,
} from '../models/PassSubmission';
const router: Router = express.Router();

// Form submission endpoint
router.post('/form-submit', async (req: Request, res: Response) => {
  try {
    if (!req.headers.authorization) {
      return res.status(401).json({error: 'No authorization header'});
    }
    const accessToken = req.headers.authorization.split(' ')[1];
    const tokenInfo = await verifyAccessToken(accessToken);

    if (!tokenInfo) {
      return res.status(401).json({error: 'Invalid access token'});
    }

    if (emailBanList.includes(tokenInfo.email)) {
      return res.status(403).json({error: 'User is banned'});
    }

    const formType = req.headers['x-form-type'];

    if (formType === 'level') {
      const submission = await LevelSubmission.create({
        artist: req.body['artist'],
        charter: req.body['charter'],
        diff: req.body['diff'],
        song: req.body['song'],
        team: req.body['team'] || '',
        vfxer: req.body['vfxer'] || '',
        videoLink: req.body['videoLink'],
        directDL: req.body['directDL'],
        wsLink: req.body['wsLink'] || '',
        baseScore:
          req.body['baseScore'] && !isNaN(parseFloat(req.body['baseScore']))
            ? parseFloat(req.body['baseScore'])
            : null,
        submitterDiscordUsername: tokenInfo.username,
        submitterEmail: tokenInfo.email,
        status: 'pending',
      });

      return res.json({
        success: true,
        message: 'Level submission saved successfully',
        submissionId: submission.id,
      });
    }

    if (formType === 'pass') {
      // Validate required fields
      const requiredFields = [
        'rawVideoId',
        'levelId',
        'passer',
        'feelingDifficulty',
        'title',
        'rawTime',
      ];

      for (const field of requiredFields) {
        if (!req.body[field]) {
          return res.status(400).json({
            error: `Missing required field: ${field}`,
          });
        }
      }

      // Create the pass submission
      const submission = await PassSubmission.create({
        levelId: req.body.levelId,
        speed: parseFloat(req.body.speed || '1'),
        passer: req.body.passer,
        feelingDifficulty: req.body.feelingDifficulty,
        title: req.body.title,
        rawVideoId: req.body.rawVideoId,
        rawTime: new Date(req.body.rawTime),
        submitterDiscordUsername: tokenInfo.username,
        submitterEmail: tokenInfo.email,
        submitterDiscordId: tokenInfo.id,
        submitterDiscordAvatar: tokenInfo.avatar,
        status: 'pending',
        assignedPlayerId: null, // Will be assigned during review
      });

      // Create judgements with proper validation
      const judgements = {
        passSubmissionId: submission.id,
        earlyDouble: Math.max(0, parseInt(req.body.earlyDouble || '0')),
        earlySingle: Math.max(0, parseInt(req.body.earlySingle || '0')),
        ePerfect: Math.max(0, parseInt(req.body.ePerfect || '0')),
        perfect: Math.max(0, parseInt(req.body.perfect || '0')),
        lPerfect: Math.max(0, parseInt(req.body.lPerfect || '0')),
        lateSingle: Math.max(0, parseInt(req.body.lateSingle || '0')),
        lateDouble: Math.max(0, parseInt(req.body.lateDouble || '0')),
      };

      await PassSubmissionJudgements.create(judgements);

      // Create flags with proper validation
      const flags = {
        passSubmissionId: submission.id,
        is12k: req.body.is12k === 'true',
        isNHT: req.body.isNHT === 'true',
        is16k: req.body.is16k === 'true',
        isLegacy: false, // Default value as per model
      };

      await PassSubmissionFlags.create(flags);

      return res.json({
        success: true,
        message: 'Pass submission saved successfully',
        submissionId: submission.id,
        data: {
          ...submission.toJSON(),
          judgements,
          flags,
        },
      });
    }

    return res.status(400).json({error: 'Invalid form type'});
  } catch (error) {
    console.error('Submission error:', error);
    return res.status(500).json({
      error: 'Failed to process submission',
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

export default router;
