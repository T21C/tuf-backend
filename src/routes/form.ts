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
import Player from '../models/Player.js';
import sequelize from '../config/db.js';

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
  async (req: Request, res: Response) => {
    // Start a transaction
    const transaction = await sequelize.transaction();

    try {
      if (req.user?.email && emailBanList.includes(req.user.email)) {
        await transaction.rollback();
        return res.status(403).json({error: 'User is banned'});
      }

      // Check if user's player is banned or submissions are paused
      if (req.user?.playerId) {
        const player = await Player.findByPk(req.user.playerId, { transaction });
        if (player?.isBanned) {
          await transaction.rollback();
          return res.status(403).json({error: 'User is banned'});
        }
        if (player?.isSubmissionsPaused) {
          await transaction.rollback();
          return res.status(403).json({error: 'User submissions are paused'});
        }
      }

      const formType = req.headers['x-form-type'];
      if (formType === 'level') {
        // Sanitize baseScore if present
        const baseScore = req.body['baseScore']
          ? Math.min(
              0,
              Math.max(0, parseFloat(req.body['baseScore'].slice(0, 9))),
            )
          : null;

        const discordProvider = req.user?.providers?.find(
          (provider: any) => provider.dataValues.provider === 'discord',
        );

        const submission = await LevelSubmission.create({
          artist: req.body['artist'],
          charter: req.body['charter'],
          diff: req.body['diff'],
          song: req.body['song'],
          team: req.body['team'] || '',
          vfxer: req.body['vfxer'] || '',
          videoLink: cleanVideoUrl(req.body['videoLink']),
          directDL: req.body['directDL'],
          wsLink: req.body['wsLink'] || '',
          baseScore,
          submitterDiscordUsername: (discordProvider?.dataValues.profile as any)
            .username,
          submitterDiscordId: (discordProvider?.dataValues.profile as any).id,
          submitterDiscordPfp: `https://cdn.discordapp.com/avatars/${(discordProvider?.dataValues.profile as any).id}/${(discordProvider?.dataValues.profile as any).avatar}.png`,
          status: 'pending',
        }, { transaction });

        await levelSubmissionHook(submission);

        // Commit transaction for level submission
        await transaction.commit();

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
            parseInt(req.body.earlyDouble?.slice(0, 9) || '0'),
          ),
          earlySingle: Math.max(
            0,
            parseInt(req.body.earlySingle?.slice(0,9) || '0'),
          ),
          ePerfect: Math.max(
            0,
            parseInt(req.body.ePerfect?.slice(0, 9) || '0'),
          ),
          perfect: Math.max(
            0,
            parseInt(req.body.perfect?.slice(0, 9) || '0'),
          ),
          lPerfect: Math.max(
            0,
            parseInt(req.body.lPerfect?.slice(0, 9) || '0'),
          ),
          lateSingle: Math.max(
            0,
            parseInt(req.body.lateSingle?.slice(0, 9) || '0'),
          ),
          lateDouble: Math.max(
            0,
            parseInt(req.body.lateDouble?.slice(0, 9) || '0'),
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
          transaction,
        });

        if (!level) {
          await transaction.rollback();
          return res.status(404).json({error: 'Level not found'});
        }
        if (!level.difficulty) {
          await transaction.rollback();
          return res.status(404).json({error: 'Difficulty not found'});
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
        
        try {
          // Create the pass submission
          const submission = await PassSubmission.create({
            levelId: req.body.levelId,
            speed: parseFloat(req.body.speed || '1'),
            scoreV2: score,
            accuracy,
            passer: req.body.passer,
            feelingDifficulty: req.body.feelingDifficulty,
            title: req.body.title,
            videoLink: cleanVideoUrl(req.body.videoLink),
            rawTime: new Date(req.body.rawTime),
            submitterDiscordUsername: (discordProvider?.dataValues.profile as any)
              .username,
            submitterDiscordId: (discordProvider?.dataValues.profile as any).id,
            submitterDiscordPfp: `https://cdn.discordapp.com/avatars/${(discordProvider?.dataValues.profile as any).id}/${(discordProvider?.dataValues.profile as any).avatar}.png`,
            status: 'pending',
            assignedPlayerId: req.user?.playerId,
          }, { transaction });

          // Create judgements
          await PassSubmissionJudgements.create({
            ...sanitizedJudgements,
            passSubmissionId: submission.id,
          }, { transaction });

          // Create flags
          const flags = {
            passSubmissionId: submission.id,
            is12K: req.body.is12K === 'true',
            isNoHoldTap: req.body.isNoHoldTap === 'true',
            is16K: req.body.is16K === 'true',
          };

          await PassSubmissionFlags.create(flags, { transaction });

          // Fetch the complete pass submission with all relations
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
            transaction,
          });

          if (!passObj) {
            await transaction.rollback();
            return res.status(500).json({error: 'Failed to create pass submission'});
          }

          // Call webhook before committing
          await passSubmissionHook(passObj, sanitizedJudgements);

          // Commit the transaction
          await transaction.commit();

          // Broadcast submission update after successful commit
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
            data: {
              ...submission.toJSON(),
              judgements: sanitizedJudgements,
              flags,
            },
          });
        } catch (error) {
          await transaction.rollback();
          throw error;
        }
      }

      await transaction.rollback();
      return res.status(400).json({error: 'Invalid form type'});
    } catch (error) {
      await transaction.rollback();
      console.error('Submission error:', error);
      return res.status(500).json({
        error: 'Failed to process submission',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

export default router;
