import express, {Request, Response, Router} from 'express';
import {Auth} from '../../middleware/auth.js';
import LevelSubmission from '../../models/submissions/LevelSubmission.js';
import {
  PassSubmission,
  PassSubmissionJudgements,
  PassSubmissionFlags,
} from '../../models/submissions/PassSubmission.js';
import {levelSubmissionHook, passSubmissionHook} from '../webhooks/webhook.js';
import Level from '../../models/levels/Level.js';
import Difficulty from '../../models/levels/Difficulty.js';
import {sseManager} from '../../utils/sse.js';
import {getScoreV2} from '../../utils/CalcScore.js';
import {calcAcc} from '../../utils/CalcAcc.js';
import LevelSubmissionCreatorRequest from '../../models/submissions/LevelSubmissionCreatorRequest.js';
import LevelSubmissionTeamRequest from '../../models/submissions/LevelSubmissionTeamRequest.js';
import Player from '../../models/players/Player.js';
import sequelize from "../../config/db.js";
import { logger } from '../../services/LoggerService.js';
import Pass from '../../models/passes/Pass.js';
import Judgement from '../../models/passes/Judgement.js';
const router: Router = express.Router();

// Add this helper function after the router declaration
const sanitizeTextInput = (input: string | null | undefined): string => {
  if (input === null || input === undefined) return '';
  return input.trim();
};


const cleanVideoUrl = (url: string) => {
  // Match various video URL formats
  const patterns = [
    // YouTube patterns
    /https?:\/\/(?:www\.)?youtube\.com\/watch\?v=([a-zA-Z0-9_-]+)/,
    /https?:\/\/(?:www\.)?youtu\.be\/([a-zA-Z0-9_-]+)/,
    /https?:\/\/(?:www\.)?youtube\.com\/live\/([a-zA-Z0-9_-]+)/,
    // Bilibili patterns
    /https?:\/\/(?:www\.|m\.)?bilibili\.com\/video\/(BV[a-zA-Z0-9]+)/,
    /https?:\/\/(?:www\.|m\.)?b23\.tv\/(BV[a-zA-Z0-9]+)/,
    /https?:\/\/(?:www\.|m\.)?bilibili\.com\/.*?(BV[a-zA-Z0-9]+)/,
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
  Auth.verified(),
  express.json(),
  async (req: Request, res: Response) => {
    // Start a transaction
    const transaction = await sequelize.transaction();

    try {
      if (req.user?.player?.isBanned) {
        return res.status(403).json({error: 'User is banned'});
      }

      if (req.user?.player?.isSubmissionsPaused) {
        return res.status(403).json({error: 'User submissions are paused'});
      }

      if (!req.user?.isEmailVerified) {
        return res.status(403).json({error: 'User email is not verified'});
      }


      const formType = req.headers['x-form-type'];
      if (formType === 'level') {
        const discordProvider = req.user?.providers?.find(
          (provider: any) => provider.dataValues?.provider === 'discord',
        );

        // Create the base level submission within transaction
        const submission = await LevelSubmission.create({
          artist: req.body.artist,
          song: req.body.song,
          diff: req.body.diff,
          videoLink: cleanVideoUrl(req.body.videoLink),
          directDL: req.body.directDL || '',
          wsLink: req.body.wsLink || '',
          submitterDiscordUsername: (discordProvider?.dataValues?.profile as any)?.username || '',
          submitterDiscordId: (discordProvider?.dataValues?.profile as any)?.id || '',
          submitterDiscordPfp: `https://cdn.discordapp.com/avatars/${(discordProvider?.dataValues?.profile as any)?.id}/${(discordProvider?.dataValues?.profile as any)?.avatar}.png` || '',
          status: 'pending',
          charter: '',
          vfxer: '',
          team: ''
        }, { transaction });

        // Create the creator request records within transaction
        if (Array.isArray(req.body.creatorRequests)) {
          await Promise.all(req.body.creatorRequests.map(async (request: any) => {
            return LevelSubmissionCreatorRequest.create({
              submissionId: submission.id,
              creatorName: request.creatorName,
              creatorId: request.creatorId || null,
              role: request.role,
              isNewRequest: request.isNewRequest
            }, { transaction });
          }));
        }

        // Create team request record if present within transaction
        if (req.body.teamRequest && req.body.teamRequest.teamName) {
          await LevelSubmissionTeamRequest.create({
            submissionId: submission.id,
            teamName: req.body.teamRequest.teamName,
            teamId: req.body.teamRequest.teamId || null,
            isNewRequest: req.body.teamRequest.isNewRequest
          }, { transaction });
        }

        // Fetch the submission with associations before sending to webhook
        const submissionWithAssociations = await LevelSubmission.findByPk(submission.id, {
          include: [
            {
              model: LevelSubmissionCreatorRequest,
              as: 'creatorRequests'
            },
            {
              model: LevelSubmissionTeamRequest,
              as: 'teamRequestData'
            }
          ],
          transaction
        });

        // Commit the transaction
        await transaction.commit();

        if (submissionWithAssociations) {
          await levelSubmissionHook(submissionWithAssociations);
        }

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
            await transaction.rollback();
            return res.status(400).json({
              error: `Missing required field: ${field}`,
            });
          }
        }

        const sanitizedJudgements = {
          earlyDouble: Math.max(
            0,
            parseInt(req.body.earlyDouble?.toString().slice(0, 9) || '0'),
          ),
          earlySingle: Math.max(
            0,
            parseInt(req.body.earlySingle?.toString().slice(0,9) || '0'),
          ),
          ePerfect: Math.max(
            0,
            parseInt(req.body.ePerfect?.toString().slice(0, 9) || '0'),
          ),
          perfect: Math.max(
            1,
            parseInt(req.body.perfect?.toString().slice(0, 9) || '0'),
          ),
          lPerfect: Math.max(
            0,
            parseInt(req.body.lPerfect?.toString().slice(0, 9) || '0'),
          ),
          lateSingle: Math.max(
            0,
            parseInt(req.body.lateSingle?.toString().slice(0, 9) || '0'),
          ),
          lateDouble: Math.max(
            0,
            parseInt(req.body.lateDouble?.toString().slice(0, 9) || '0'),
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
          transaction
        });
        
        if (!level) {
          await transaction.rollback();
          return res.status(404).json({error: 'Level not found'});
        }
        if (!level.difficulty) {
          await transaction.rollback();
          return res.status(404).json({error: 'Difficulty not found'});
        }

        const existingJudgement = await Judgement.findOne({
          where: {
            earlyDouble: sanitizedJudgements.earlyDouble,
            earlySingle: sanitizedJudgements.earlySingle,
            ePerfect: sanitizedJudgements.ePerfect,
            perfect: sanitizedJudgements.perfect,
            lPerfect: sanitizedJudgements.lPerfect,
            lateSingle: sanitizedJudgements.lateSingle,
            lateDouble: sanitizedJudgements.lateDouble,
          },
        });
        logger.info(`Existing judgement: ${existingJudgement}`);
        const existingPass = existingJudgement ? await Pass.findOne({
          where: {
            id: existingJudgement.id,
            levelId: req.body.levelId,
            speed: parseFloat(req.body.speed || "1"),
            videoLink: cleanVideoUrl(req.body.videoLink),
            is12K: req.body.is12K === true,
            isNoHoldTap: req.body.isNoHoldTap === true,
            is16K: req.body.is16K === true,
          },
        }) : null;
        logger.info(`Existing pass: ${existingPass?.id}`);
        if (existingPass) {
          await transaction.rollback();
          return res.status(400).json({
            error: 'A pass with identical video, judgements, and flags already exists for this level and speed',
            details: {
              levelId: req.body.levelId,
              speed: req.body.speed || 1,
              videoLink: cleanVideoUrl(req.body.videoLink),
              title: req.body.title,
            }
          });
        }

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
        
        // Create the pass submission within transaction
        const submission = await PassSubmission.create({
          levelId: req.body.levelId,
          speed: req.body.speed ? parseFloat(req.body.speed) : 1,
          scoreV2: score,
          accuracy,
          passer: sanitizeTextInput(req.body.passer),
          passerId: req.body.passerId,
          passerRequest: req.body.passerRequest === true,
          feelingDifficulty: sanitizeTextInput(req.body.feelingDifficulty),
          title: req.body.title,
          videoLink: cleanVideoUrl(req.body.videoLink),
          rawTime: new Date(req.body.rawTime),
          submitterDiscordUsername: (discordProvider?.dataValues?.profile as any)?.username,
          submitterDiscordId: (discordProvider?.dataValues?.profile as any)?.id,
          submitterDiscordPfp: `https://cdn.discordapp.com/avatars/${(discordProvider?.dataValues?.profile as any)?.id}/${(discordProvider?.dataValues?.profile as any)?.avatar}.png`,
          status: 'pending',
          assignedPlayerId: req.body.passerRequest === false ? req.body.passerId : null,
        }, { transaction });

        await PassSubmissionJudgements.create({
          ...sanitizedJudgements,
          passSubmissionId: submission.id,
        }, { transaction });

        // Create flags with proper validation
        const flags = {
          passSubmissionId: submission.id,
          is12K: req.body.is12K === true,
          isNoHoldTap: req.body.isNoHoldTap === true,
          is16K: req.body.is16K === true,
        };

        await PassSubmissionFlags.create(flags, { transaction });
        
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
          transaction
        });

        if (!passObj) {
          await transaction.rollback();
          return res.status(500).json({error: 'Failed to create pass submission'});
        }

        // Commit the transaction
        await transaction.commit();

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

      await transaction.rollback();
      return res.status(400).json({error: 'Invalid form type'});
    } catch (error) {
      // Rollback transaction on error
      await transaction.rollback();
      logger.error('Submission error:', error);
      return res.status(500).json({
        error: 'Failed to process submission',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

export default router;
