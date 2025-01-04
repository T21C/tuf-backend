import express, {Request, Response, Router} from 'express';
import {Auth} from '../middleware/auth';
import {emailBanList} from '../config/constants.js';
import LevelSubmission from '../models/LevelSubmission';
import {
  PassSubmission,
  PassSubmissionJudgements,
  PassSubmissionFlags,
} from '../models/PassSubmission';
import { levelSubmissionHook, passSubmissionHook } from './webhooks/webhook.js';
import Level from '../models/Level.js';
import Difficulty from '../models/Difficulty.js';
import { sseManager } from '../utils/sse';
const router: Router = express.Router();

// Form submission endpoint
router.post('/form-submit', Auth.user(), async (req: Request, res: Response) => {
  try {
    if (req.user?.email && emailBanList.includes(req.user.email)) {
      return res.status(403).json({error: 'User is banned'});
    }

    const formType = req.headers['x-form-type'];
    if (formType === 'level') {
      // Sanitize baseScore if present
      const baseScore = req.body['baseScore'] 
        ? Math.min(0, Math.max(0, parseFloat(req.body['baseScore'].slice(0, 9))))
        : null;

      const discordProvider = req.user?.providers?.find(provider => provider.dataValues.provider === 'discord');

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
        baseScore,
        submitterDiscordUsername: (discordProvider?.dataValues.profile as any).username,
        submitterDiscordId: (discordProvider?.dataValues.profile as any).id,
        submitterDiscordPfp: `https://cdn.discordapp.com/avatars/${(discordProvider?.dataValues.profile as any).id}/${(discordProvider?.dataValues.profile as any).avatar}.png`,
        status: 'pending',
      });

      await levelSubmissionHook(submission);

      // Broadcast submission update
      sseManager.broadcast({
        type: 'submissionUpdate',
        data: {
          action: 'create',
          submissionId: submission.id,
          submissionType: 'level'
        }
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
        'videoLink',
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

      const discordProvider = req.user?.providers?.find(provider => provider.dataValues.provider === 'discord');

      // Create the pass submission
      const submission = await PassSubmission.create({
        levelId: req.body.levelId,
        speed: parseFloat(req.body.speed || '1'),
        passer: req.body.passer,
        feelingDifficulty: req.body.feelingDifficulty,
        title: req.body.title,
        videoLink: req.body.videoLink,
        rawTime: new Date(req.body.rawTime),
        submitterDiscordUsername: (discordProvider?.dataValues.profile as any).username,
        submitterDiscordId: (discordProvider?.dataValues.profile as any).id,
        submitterDiscordPfp: `https://cdn.discordapp.com/avatars/${(discordProvider?.dataValues.profile as any).id}/${(discordProvider?.dataValues.profile as any).avatar}.png`,
        status: 'pending',
        assignedPlayerId: null, // Will be assigned during review
      });

      // Sanitize numeric inputs
      const sanitizedJudgements = {
        passSubmissionId: submission.id,
        earlyDouble: Math.max(0, parseInt(req.body.earlyDouble?.slice(0, 15) || '0')),
        earlySingle: Math.max(0, parseInt(req.body.earlySingle?.slice(0, 15) || '0')),
        ePerfect: Math.max(0, parseInt(req.body.ePerfect?.slice(0, 15) || '0')),
        perfect: Math.max(0, parseInt(req.body.perfect?.slice(0, 15) || '0')),
        lPerfect: Math.max(0, parseInt(req.body.lPerfect?.slice(0, 15) || '0')),
        lateSingle: Math.max(0, parseInt(req.body.lateSingle?.slice(0, 15) || '0')),
        lateDouble: Math.max(0, parseInt(req.body.lateDouble?.slice(0, 15) || '0')),
      };
      
      await PassSubmissionJudgements.create(sanitizedJudgements);

      // Create flags with proper validation
      const flags = {
        passSubmissionId: submission.id,
        is12K: req.body.is12K === 'true',
        isNoHoldTap: req.body.isNoHoldTap === 'true',
        is16K: req.body.is16K === 'true',
      };

      await PassSubmissionFlags.create(flags);
      const passObj = await PassSubmission.findByPk(
        submission.id,
        {
          include: [
            {
              model: PassSubmissionJudgements,
              as: 'judgements',
            },
            {
              model: PassSubmissionFlags,
              as: 'flags',
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
        }
      );
      if (!passObj) return res.status(500).json({error: 'Failed to create pass submission'});
      await passSubmissionHook(passObj);

      // Broadcast submission update
      sseManager.broadcast({
        type: 'submissionUpdate',
        data: {
          action: 'create',
          submissionId: submission.id,
          submissionType: 'pass'
        }
      });

      return res.json({
        success: true,
        message: 'Pass submission saved successfully',
        submissionId: submission.id,
        data: {
          ...submission.toJSON(),
          judgements: sanitizedJudgements,
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
