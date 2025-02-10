import express, {Request, Response, Router} from 'express';
import {Auth} from '../middleware/auth.js';
import {emailBanList} from '../config/constants.js';
import LevelSubmission from '../models/LevelSubmission.js';
import {
  PassSubmission,
  PassSubmissionJudgements,
  PassSubmissionFlags,
} from '../models/PassSubmission.js';
import {levelSubmissionHook, passSubmissionHook} from './webhooks/webhook.js';
import Level from '../models/Level.js';
import Difficulty from '../models/Difficulty.js';
import {sseManager} from '../utils/sse.js';
import {getScoreV2} from '../misc/CalcScore.js';
import {calcAcc} from '../misc/CalcAcc.js';
import LevelSubmissionCreatorRequest from '../models/LevelSubmissionCreatorRequest.js';
import LevelSubmissionTeamRequest from '../models/LevelSubmissionTeamRequest.js';
import Player from '../models/Player.js';
const router: Router = express.Router();

const cleanVideoUrl = (url: string) => {
  // Match various video URL formats
  const patterns = [
    // YouTube patterns
    /https?:\/\/(?:www\.)?youtube\.com\/watch\?v=([a-zA-Z0-9_-]+)/,
    /https?:\/\/(?:www\.)?youtu\.be\/([a-zA-Z0-9_-]+)/,
    /https?:\/\/(?:www\.)?youtube\.com\/live\/([a-zA-Z0-9_-]+)/,
    // Bilibili patterns
    /https?:\/\/(?:www\.)?bilibili\.com\/video\/(BV[a-zA-Z0-9]+)/,
    /https?:\/\/(?:www\.)?b23\.tv\/(BV[a-zA-Z0-9]+)/,
    /https?:\/\/(?:www\.)?bilibili\.com\/.*?(BV[a-zA-Z0-9]+)/
  ];

  // Try each pattern
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) {
      // For Bilibili links, construct the standard URL format
      if (match[1] && match[1].startsWith('BV')) {
        return `https://www.bilibili.com/video/${match[1]}`;
      }
      // For YouTube links, construct based on the first pattern
      if (match[1]) {
        return `https://www.youtube.com/watch?v=${match[1]}`;
      }
    }
  }

  // If no pattern matches, return the original URL
  return url;
};

// Form submission endpoint
router.post(
  '/form-submit',
  Auth.user(),
  express.json(),
  async (req: Request, res: Response) => {
    try {
      if (req.user?.email && emailBanList.includes(req.user.email)) {
        return res.status(403).json({error: 'User is banned'});
      }

      // Check if user's player is banned or submissions are paused
      if (req.user?.playerId) {
        const player = await Player.findByPk(req.user.playerId);
        if (player?.isBanned) {
          return res.status(403).json({error: 'User is banned'});
        }
        if (player?.isSubmissionsPaused) {
          return res.status(403).json({error: 'User submissions are paused'});
        }
      }

      const formType = req.headers['x-form-type'];
      if (formType === 'level') {
        const discordProvider = req.user?.providers?.find(
          (provider: any) => provider.dataValues.provider === 'discord',
        );

        // Create the base level submission
        const submission = await LevelSubmission.create({
          artist: req.body.artist,
          song: req.body.song,
          diff: req.body.diff,
          videoLink: cleanVideoUrl(req.body.videoLink),
          directDL: req.body.directDL || '',
          wsLink: req.body.wsLink || '',
          submitterDiscordUsername: (discordProvider?.dataValues.profile as any).username,
          submitterDiscordId: (discordProvider?.dataValues.profile as any).id,
          submitterDiscordPfp: `https://cdn.discordapp.com/avatars/${(discordProvider?.dataValues.profile as any).id}/${(discordProvider?.dataValues.profile as any).avatar}.png`,
          status: 'pending',
          charter: '',
          vfxer: '',
          team: ''
        });

        // Create the creator request records
        if (Array.isArray(req.body.creatorRequests)) {
          await Promise.all(req.body.creatorRequests.map(async (request: any) => {
            return LevelSubmissionCreatorRequest.create({
              submissionId: submission.id,
              creatorName: request.creatorName,
              creatorId: request.creatorId || null,
              role: request.role,
              isNewRequest: request.isNewRequest
            });
          }));
        }

        // Create team request record if present
        if (req.body.teamRequest && req.body.teamRequest.teamName) {
          await LevelSubmissionTeamRequest.create({
            submissionId: submission.id,
            teamName: req.body.teamRequest.teamName,
            teamId: req.body.teamRequest.teamId || null,
            isNewRequest: req.body.teamRequest.isNewRequest
          });
        }

        await levelSubmissionHook(submission);

        // Broadcast submission update
        sseManager.broadcast({
          type: 'submissionUpdate',
          data: {
            action: 'create',
            submissionId: submission.id,
            submissionType: 'level',
          },
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

        const sanitizedJudgements = {
          earlyDouble: Math.max(
            0,
            parseInt(req.body.earlyDouble?.slice(0, 15) || '0'),
          ),
          earlySingle: Math.max(
            0,
            parseInt(req.body.earlySingle?.slice(0, 15) || '0'),
          ),
          ePerfect: Math.max(
            0,
            parseInt(req.body.ePerfect?.slice(0, 15) || '0'),
          ),
          perfect: Math.max(0, parseInt(req.body.perfect?.slice(0, 15) || '0')),
          lPerfect: Math.max(
            0,
            parseInt(req.body.lPerfect?.slice(0, 15) || '0'),
          ),
          lateSingle: Math.max(
            0,
            parseInt(req.body.lateSingle?.slice(0, 15) || '0'),
          ),
          lateDouble: Math.max(
            0,
            parseInt(req.body.lateDouble?.slice(0, 15) || '0'),
          ),
        };

        const discordProvider = req.user?.providers?.find(
          (provider: any) => provider.dataValues.provider === 'discord',
        );

        const level = await Level.findByPk(req.body.levelId, {
          include: [
            {
              model: Difficulty,
              as: 'difficulty',
            },
          ],
        });
        if (!level) return res.status(404).json({error: 'Level not found'});
        if (!level.difficulty)
          return res.status(404).json({error: 'Difficulty not found'});

        // Create properly structured level data for score calculation
        const levelData = {
          baseScore: level.baseScore,
          difficulty: level.difficulty,
        };

        const score = getScoreV2(
          {
            speed: parseFloat(req.body.speed || '1'),
            judgements: sanitizedJudgements,
            isNoHoldTap: req.body.isNoHoldTap === 'true',
          },
          levelData,
        );

        const accuracy = calcAcc(sanitizedJudgements);
        // Create the pass submission
        const submission = await PassSubmission.create({
          levelId: req.body.levelId,
          speed: parseFloat(req.body.speed || '1'),
          scoreV2: score,
          accuracy,
          passer: req.body.passer,
          assignedPlayerId: req.body.passerId || null,
          passerRequest: req.body.passerRequest === 'true',
          feelingDifficulty: req.body.feelingDifficulty,
          title: req.body.title,
          videoLink: cleanVideoUrl(req.body.videoLink),
          rawTime: new Date(req.body.rawTime),
          submitterDiscordUsername: (discordProvider?.dataValues.profile as any)
            .username,
          submitterDiscordId: (discordProvider?.dataValues.profile as any).id,
          submitterDiscordPfp: `https://cdn.discordapp.com/avatars/${(discordProvider?.dataValues.profile as any).id}/${(discordProvider?.dataValues.profile as any).avatar}.png`,
          status: 'pending',
        });

        await PassSubmissionJudgements.create({
          ...sanitizedJudgements,
          passSubmissionId: submission.id,
        });

        // Create flags with proper validation
        const flags = {
          passSubmissionId: submission.id,
          is12K: req.body.is12K === 'true',
          isNoHoldTap: req.body.isNoHoldTap === 'true',
          is16K: req.body.is16K === 'true',
        };

        await PassSubmissionFlags.create(flags);
        const passObj = await PassSubmission.findByPk(submission.id, {
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
        });
        if (!passObj)
          return res
            .status(500)
            .json({error: 'Failed to create pass submission'});
        await passSubmissionHook(passObj, sanitizedJudgements);

        // Broadcast submission update
        sseManager.broadcast({
          type: 'submissionUpdate',
          data: {
            action: 'create',
            submissionId: submission.id,
            submissionType: 'pass',
          },
        });

        return res.json({
          success: true,
          message: 'Pass submission saved successfully',
          submissionId: submission.id,
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
  },
);

export default router;
