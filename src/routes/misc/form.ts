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
import sequelize from "../../config/db.js";
import { Transaction } from 'sequelize';
import { logger } from '../../services/LoggerService.js';
import Pass from '../../models/passes/Pass.js';
import Judgement from '../../models/passes/Judgement.js';
import cdnService from '../../services/CdnService.js';
import { CdnError } from '../../services/CdnService.js';
import { CDN_CONFIG } from '../../cdnService/config.js';
import multer from 'multer';
import fs from 'fs';
import { User } from '../../models/index.js';
import Player from '../../models/players/Player.js';
import { safeTransactionRollback } from '../../utils/Utility.js';
import { hasFlag } from '../../utils/permissionUtils.js';
import { permissionFlags } from '../../config/constants.js';

const router: Router = express.Router();

// Configure multer for handling file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    cb(null, file.originalname);
  }
});
const upload = multer({ 
  storage,
  limits: {
    fileSize: 1000 * 1024 * 1024 // 1GB limit
  }
});

// Enhanced input validation and sanitization
const sanitizeTextInput = (input: string | null | undefined): string => {
  if (input === null || input === undefined) return '';
  return input.trim();
};

const validateNumericInput = (input: any, min: number = 0, max: number = Number.MAX_SAFE_INTEGER): number => {
  const parsed = parseInt(input?.toString() || '0');
  if (isNaN(parsed)) return min;
  return Math.max(min, Math.min(max, parsed));
};

const validateFloatInput = (input: any, min: number = 0, max: number = Number.MAX_SAFE_INTEGER): number => {
  const parsed = parseFloat(input?.toString() || '0');
  if (isNaN(parsed)) return min;
  return Math.max(min, Math.min(max, parsed));
};

// Enhanced JSON parsing with validation
const safeParseJSON = (input: string | object | null | undefined): any => {
  if (input === null || input === undefined) return null;
  if (typeof input === 'object') return input;
  try {
    return JSON.parse(input);
  } catch (error) {
    logger.error('Failed to parse JSON:', {
      error: error instanceof Error ? error.message : String(error),
      input: typeof input === 'string' ? input.substring(0, 100) : input,
      timestamp: new Date().toISOString()
    });
    return null;
  }
};

// Validate creator request structure
const validateCreatorRequest = (request: any): boolean => {
  return request && 
         typeof request.creatorName === 'string' && 
         request.creatorName.trim().length > 0 &&
         typeof request.role === 'string' &&
         request.role.trim().length > 0;
};

// Validate team request structure
const validateTeamRequest = (request: any): boolean => {
  return request && 
         typeof request.teamName === 'string' && 
         request.teamName.trim().length > 0;
};

const cleanVideoUrl = (url: string) => {
  if (!url || typeof url !== 'string') return '';
  
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

// Enhanced file cleanup with better error handling
async function cleanUpFile(req: Request) {
  if (req.file?.path) {
    try {
      // Check if file exists before attempting to delete
      await fs.promises.access(req.file.path);
      await fs.promises.unlink(req.file.path);
      logger.debug('Temporary file cleaned up successfully:', {
        path: req.file.path,
        timestamp: new Date().toISOString()
      });
    } catch (cleanupError) {
      // File might not exist or already be deleted
      if ((cleanupError as any).code === 'ENOENT') {
        logger.debug('Temporary file already deleted:', {
          path: req.file.path,
          timestamp: new Date().toISOString()
        });
      } else {
        logger.error('Failed to clean up temporary file:', {
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          path: req.file.path,
          timestamp: new Date().toISOString()
        });
      }
    }
  }
}

// Enhanced CDN cleanup
async function cleanUpCdnFile(fileId: string | null) {
  if (!fileId) return;
  
  try {
    await cdnService.deleteFile(fileId);
    logger.debug('CDN file cleaned up successfully:', {
      fileId,
      timestamp: new Date().toISOString()
    });
  } catch (cleanupError) {
    logger.error('Failed to clean up CDN file:', {
      error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      fileId,
      timestamp: new Date().toISOString()
    });
  }
}

// Form submission endpoint
router.post(
  '/form-submit',
  Auth.user(),
  upload.single('levelZip'),
  express.json(),
  async (req: Request, res: Response) => {
    let transaction: Transaction | undefined;
    let uploadedFileId: string | null = null;
    
    try {
      // Start a transaction
      transaction = await sequelize.transaction();

      // Enhanced user validation
      if (!req.user) {
        await safeTransactionRollback(transaction);
        return res.status(401).json({error: 'User not authenticated'});
      }

      if (hasFlag(req.user, permissionFlags.BANNED)) {
        await cleanUpFile(req);
        await safeTransactionRollback(transaction);
        return res.status(403).json({error: 'You are banned'});
      }

      if (hasFlag(req.user, permissionFlags.SUBMISSIONS_PAUSED)) {
        await cleanUpFile(req);
        await safeTransactionRollback(transaction);
        return res.status(403).json({error: 'Your submissions are paused'});
      }

      if (!hasFlag(req.user, permissionFlags.EMAIL_VERIFIED)) {
        await cleanUpFile(req);
        await safeTransactionRollback(transaction);
        return res.status(403).json({error: 'Your email is not verified'});
      }

      const formType = req.headers['x-form-type'];
      if (formType === 'level') {
        // Validate required fields for level submission
        const requiredFields = ['artist', 'song', 'diff', 'videoLink'];
        for (const field of requiredFields) {
          if (!req.body[field] || typeof req.body[field] !== 'string' || req.body[field].trim().length === 0) {
            await cleanUpFile(req);
            await safeTransactionRollback(transaction);
            return res.status(400).json({
              error: `Missing or invalid required field: ${field}`,
            });
          }
        }

        // Validate directDL if provided
        if (req.body.directDL && req.body.directDL.startsWith(CDN_CONFIG.baseUrl)) {
          await cleanUpFile(req);
          await safeTransactionRollback(transaction);
          return res.status(400).json({
            error: 'Direct download cannot point to local CDN',
            details: {
              directDL: req.body.directDL
            }
          });
        }

        const discordProvider = req.user?.providers?.find(
          (provider: any) => provider.dataValues?.provider === 'discord',
        );

        const existingSubmissions = await LevelSubmission.findAll({
          where: {
            status: 'pending',
            artist: req.body.artist,
            song: req.body.song,
            userId: req.user?.id,
            videoLink: cleanVideoUrl(req.body.videoLink),
          },
          transaction
        });
        
        if (existingSubmissions.length > 0) {
          await cleanUpFile(req);
          await safeTransactionRollback(transaction);
          return res.status(400).json({
            error: "You've already submitted this level, please wait for approval.",
          });
        }

        // Handle level zip file if present
        let directDL: string | null = null;
        let hasZipUpload = false;
        let levelFiles: any[] = [];

        if (req.file) {
          try {
            // Validate file size
            if (req.file.size > 1000 * 1024 * 1024) { // 1GB
              await cleanUpFile(req);
              await safeTransactionRollback(transaction);
              return res.status(400).json({
                error: 'File size exceeds maximum allowed size (1GB)',
              });
            }

            // Read file from disk instead of using buffer
            const fileBuffer = await fs.promises.readFile(req.file.path);
            
            const uploadResult = await cdnService.uploadLevelZip(
              fileBuffer, 
              req.file.originalname
            );

            // Store fileId for potential cleanup
            uploadedFileId = uploadResult.fileId;

            // Clean up the temporary file
            await fs.promises.unlink(req.file.path);

            // Get the level files from the CDN service
            levelFiles = await cdnService.getLevelFiles(uploadResult.fileId);
            
            // If only one level file, use it directly
            directDL = `${CDN_CONFIG.baseUrl}/${uploadResult.fileId}`;
            hasZipUpload = true;
          } catch (error) {
            // Clean up the temporary file in case of error
            await cleanUpFile(req);
            
            // Clean up CDN file if it was uploaded
            if (uploadedFileId) {
              await cleanUpCdnFile(uploadedFileId);
            }

            logger.error('Failed to upload zip file to CDN:', {
              error: error instanceof Error ? {
                message: error.message,
                stack: error.stack
              } : error,
              filename: req.file.originalname,
              size: req.file.size,
              timestamp: new Date().toISOString()
            });
            
            await safeTransactionRollback(transaction);
            throw error;
          }
        }

        const submission = await LevelSubmission.create({
          artist: sanitizeTextInput(req.body.artist),
          song: sanitizeTextInput(req.body.song),
          diff: sanitizeTextInput(req.body.diff),
          videoLink: cleanVideoUrl(req.body.videoLink),
          directDL: directDL || sanitizeTextInput(req.body.directDL) || '',
          userId: req.user?.id,
          wsLink: sanitizeTextInput(req.body.wsLink) || '',
          submitterDiscordUsername: (discordProvider?.dataValues?.profile as any)?.username || '',
          submitterDiscordId: (discordProvider?.dataValues?.profile as any)?.id || '',
          submitterDiscordPfp: `https://cdn.discordapp.com/avatars/${(discordProvider?.dataValues?.profile as any)?.id}/${(discordProvider?.dataValues?.profile as any)?.avatar}.png` || '',
          status: 'pending',
          charter: '',
          vfxer: '',
          team: ''
        }, { transaction });

        const parsedCreatorRequests = safeParseJSON(req.body.creatorRequests);
        // Create the creator request records within transaction with validation
        if (Array.isArray(parsedCreatorRequests)) {
          const validRequests = parsedCreatorRequests.filter(validateCreatorRequest);
          if (validRequests.length !== parsedCreatorRequests.length) {
            logger.warn('Some creator requests were invalid and filtered out:', {
              total: parsedCreatorRequests.length,
              valid: validRequests.length,
              timestamp: new Date().toISOString()
            });
          }
          
          await Promise.all(validRequests.map(async (request: any) => {
            return LevelSubmissionCreatorRequest.create({
              submissionId: submission.id,
              creatorName: sanitizeTextInput(request.creatorName),
              creatorId: request.creatorId || null,
              role: sanitizeTextInput(request.role),
              isNewRequest: request.isNewRequest || false
            }, { transaction });
          }));
        }

        // Create team request record if present within transaction with validation
        const parsedTeamRequest = safeParseJSON(req.body.teamRequest);
        if (parsedTeamRequest && validateTeamRequest(parsedTeamRequest)) {
          await LevelSubmissionTeamRequest.create({
            submissionId: submission.id,
            teamName: sanitizeTextInput(parsedTeamRequest.teamName),
            teamId: parsedTeamRequest.teamId || null,
            isNewRequest: parsedTeamRequest.isNewRequest
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
            },
            {
              model: User,
              as: 'levelSubmitter',
              attributes: ['id', 'username', 'playerId']
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

        // If we have multiple level files, return them to the client
        if (levelFiles.length > 1) {
          // Broadcast level selection event
          sseManager.broadcast({
            type: 'levelSelection',
            data: {
              fileId: uploadedFileId,
              levelFiles: levelFiles.map(file => ({
                name: file.name,
                size: file.size,
                hasYouTubeStream: file.hasYouTubeStream,
                songFilename: file.songFilename,
                artist: file.artist,
                song: file.song,
                author: file.author,
                difficulty: file.difficulty,
                bpm: file.bpm
              }))
            }
          });

          return res.json({
            success: true,
            message: 'Level submission saved successfully',
            submissionId: submission.id,
            requiresLevelSelection: true,
            levelFiles: levelFiles.map(file => ({
              name: file.name,
              size: file.size,
              hasYouTubeStream: file.hasYouTubeStream,
              songFilename: file.songFilename,
              artist: file.artist,
              song: file.song,
              author: file.author,
              difficulty: file.difficulty,
              bpm: file.bpm
            })),
            fileId: uploadedFileId
          });
        }

        return res.json({
          success: true,
          message: 'Level submission saved successfully',
          submissionId: submission.id
        });
      }

      if (formType === 'pass') {
        // Validate required fields with enhanced validation
        const requiredFields = [
          'videoLink',
          'levelId',
          'passer',
          'feelingDifficulty',
          'title',
          'rawTime',
        ];

        for (const field of requiredFields) {
          if (!req.body[field] || (typeof req.body[field] === 'string' && req.body[field].trim().length === 0)) {
            await cleanUpFile(req);
            await safeTransactionRollback(transaction);
            return res.status(400).json({
              error: `Missing or invalid required field: ${field}`,
            });
          }
        }

        // Validate levelId is a valid number
        const levelId = parseInt(req.body.levelId);
        if (isNaN(levelId) || levelId <= 0) {
          await cleanUpFile(req);
          await safeTransactionRollback(transaction);
          return res.status(400).json({
            error: 'Invalid level ID',
          });
        }

        // Enhanced judgement validation with proper bounds
        const sanitizedJudgements = {
          earlyDouble: validateNumericInput(req.body.earlyDouble, 0, 999999999),
          earlySingle: validateNumericInput(req.body.earlySingle, 0, 999999999),
          ePerfect: validateNumericInput(req.body.ePerfect, 0, 999999999),
          perfect: validateNumericInput(req.body.perfect, 1, 999999999), // Must be at least 1
          lPerfect: validateNumericInput(req.body.lPerfect, 0, 999999999),
          lateSingle: validateNumericInput(req.body.lateSingle, 0, 999999999),
          lateDouble: validateNumericInput(req.body.lateDouble, 0, 999999999),
        };

        // Validate speed if provided
        const speed = req.body.speed ? validateFloatInput(req.body.speed, 1, 100) : 1;

        const discordProvider = req.user?.providers?.find(
          (provider: any) => provider.dataValues.provider === 'discord',
        );

        const level = await Level.findByPk(levelId, {
          include: [
            {
              model: Difficulty,
              as: 'difficulty',
            },
          ],
          transaction
        });
        
        if (!level) {
          await cleanUpFile(req);
          await safeTransactionRollback(transaction);
          return res.status(404).json({error: 'Level not found'});
        }
        if (!level.difficulty) {
          await cleanUpFile(req);
          await safeTransactionRollback(transaction);
          return res.status(404).json({error: 'Difficulty not found'});
        }

        const existingSubmission = await PassSubmission.findOne({
          where: {
            levelId: levelId,
            speed: speed,
            passer: sanitizeTextInput(req.body.passer),
            passerRequest: req.body.passerRequest === true,
            title: sanitizeTextInput(req.body.title),
            videoLink: cleanVideoUrl(req.body.videoLink),
            rawTime: new Date(req.body.rawTime),
          },
          transaction
        });

        let existingSubmissionJudgements: PassSubmissionJudgements | null = null;
        let existingSubmissionFlags: PassSubmissionFlags | null = null;
        if (existingSubmission) {
          existingSubmissionJudgements = await PassSubmissionJudgements.findOne({
            where: {
              passSubmissionId: existingSubmission?.id,
              earlyDouble: sanitizedJudgements.earlyDouble,
              earlySingle: sanitizedJudgements.earlySingle,
              ePerfect: sanitizedJudgements.ePerfect,
              perfect: sanitizedJudgements.perfect,
              lPerfect: sanitizedJudgements.lPerfect,
              lateSingle: sanitizedJudgements.lateSingle,
              lateDouble: sanitizedJudgements.lateDouble,
            },
            transaction
          });
          existingSubmissionFlags = await PassSubmissionFlags.findOne({
            where: {
              passSubmissionId: existingSubmission?.id,
              is12K: req.body.is12K === true,
              isNoHoldTap: req.body.isNoHoldTap === true,
              is16K: req.body.is16K === true,
            },
            transaction
          });
        }

        if (existingSubmissionJudgements && existingSubmissionFlags) {
          await cleanUpFile(req);
          await safeTransactionRollback(transaction);
          return res.status(400).json({
            error: 'Identical submission already exists',
            details: {
              levelId: levelId,
              speed: speed,
              videoLink: cleanVideoUrl(req.body.videoLink),
            }
          });
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
          transaction
        });
        
        const existingPass = existingJudgement ? await Pass.findOne({
          where: {
            id: existingJudgement.id,
            levelId: levelId,
            speed: speed,
            videoLink: cleanVideoUrl(req.body.videoLink),
            is12K: req.body.is12K === true,
            isNoHoldTap: req.body.isNoHoldTap === true,
            is16K: req.body.is16K === true,
          },
          transaction
        }) : null;
        
        if (existingPass) {
          await cleanUpFile(req);
          await safeTransactionRollback(transaction);
          return res.status(400).json({
            error: 'A pass with identical video, judgements, and flags already exists for this level and speed',
            details: {
              levelId: levelId,
              speed: speed,
              videoLink: cleanVideoUrl(req.body.videoLink),
              title: sanitizeTextInput(req.body.title),
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
            speed: speed,
            judgements: sanitizedJudgements,
            isNoHoldTap: req.body.isNoHoldTap === 'true',
          },
          levelData,
        );

        const accuracy = calcAcc(sanitizedJudgements);
        
        // Create the pass submission within transaction
        const submission = await PassSubmission.create({
          levelId: levelId,
          speed: speed,
          scoreV2: score,
          accuracy,
          passer: sanitizeTextInput(req.body.passer),
          passerId: req.body.passerId,
          passerRequest: req.body.passerRequest === true,
          feelingDifficulty: sanitizeTextInput(req.body.feelingDifficulty),
          title: sanitizeTextInput(req.body.title),
          videoLink: cleanVideoUrl(req.body.videoLink),
          rawTime: new Date(req.body.rawTime),
          submitterDiscordUsername: (discordProvider?.dataValues?.profile as any)?.username,
          submitterDiscordId: (discordProvider?.dataValues?.profile as any)?.id,
          submitterDiscordPfp: `https://cdn.discordapp.com/avatars/${(discordProvider?.dataValues?.profile as any)?.id}/${(discordProvider?.dataValues?.profile as any)?.avatar}.png`,
          status: 'pending',
          assignedPlayerId: req.body.passerRequest === false ? req.body.passerId : null,
          userId: req.user?.id,
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
            {
              model: User,
              as: 'passSubmitter',
              attributes: ['id', 'username', 'playerId', 'avatarUrl'],
              include: [
                {
                  model: Player,
                  as: 'player'
                }
              ]
            }
          ],
          transaction
        });

        if (!passObj) {
          throw new Error('Failed to create pass submission');
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

      await cleanUpFile(req);
      await safeTransactionRollback(transaction);
      return res.status(400).json({error: 'Invalid form type'});
    } catch (error) {
      // Enhanced error handling with proper cleanup
      logger.error('Submission error:', {
        error: error instanceof Error ? {
          message: error.message,
          stack: error.stack
        } : error,
        formType: req.headers['x-form-type'],
        userId: req.user?.id,
        timestamp: new Date().toISOString()
      });

      // Clean up uploaded CDN file if transaction failed
      if (uploadedFileId) {
        await cleanUpCdnFile(uploadedFileId);
      }

      // Clean up any uploaded file
      await cleanUpFile(req);

      // Only attempt rollback if transaction exists
      if (transaction) {
        try {
          await safeTransactionRollback(transaction);
        } catch (rollbackError) {
          // If rollback fails, it likely means the transaction was already rolled back
          logger.warn('Transaction rollback failed:', rollbackError);
        }
      }

      return res.status(500).json({
        error: 'Failed to process submission',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

// Level selection endpoint
router.post('/select-level', Auth.verified(), async (req: Request, res: Response) => {
    const { submissionId, selectedLevel } = req.body;

    // Enhanced input validation
    if (!submissionId || !selectedLevel) {
        return res.status(400).json({
            success: false,
            error: 'Missing required parameters'
        });
    }

    // Validate submissionId is a valid number
    const parsedSubmissionId = parseInt(submissionId);
    if (isNaN(parsedSubmissionId) || parsedSubmissionId <= 0) {
        return res.status(400).json({
            success: false,
            error: 'Invalid submission ID'
        });
    }

    // Validate selectedLevel is a string
    if (typeof selectedLevel !== 'string' || selectedLevel.trim().length === 0) {
        return res.status(400).json({
            success: false,
            error: 'Invalid selected level'
        });
    }

    try {
        // Set the target level in CDN
        const submission = await LevelSubmission.findOne({
            where: {
                id: parsedSubmissionId,
                userId: req.user?.id,
                status: 'pending'
            }
        });

        if (!submission) {
            return res.status(404).json({
                success: false,
                error: 'Level submission not found'
            });
        }

        if (!submission.directDL.startsWith(CDN_CONFIG.baseUrl)) {
            return res.status(400).json({
                success: false,
                error: 'Download link is not on local CDN',
                directDL: submission.directDL
            });
        }

        const fileId = submission.directDL.split('/').pop() || '';
        if (!fileId) {
            return res.status(400).json({
                success: false,
                error: 'Invalid directDL URL',
                directDL: submission.directDL
            });
        }

        // Get available level files first to validate the selection
        const levelFiles = await cdnService.getLevelFiles(fileId);
        const selectedFile = levelFiles.find(file => file.name === selectedLevel);

        if (!selectedFile) {
            logger.error('Selected level file not found:', {
                fileId,
                selectedLevel,
                availableFiles: levelFiles.map(f => f.name),
                timestamp: new Date().toISOString()
            });
            return res.status(400).json({
                success: false,
                error: 'Selected level file not found',
                availableFiles: levelFiles.map(f => f.name)
            });
        }

        // Set the target level in CDN
        await cdnService.setTargetLevel(fileId, selectedLevel);

        return res.json({
            success: true,
            selectedFile: {
                name: selectedFile.name,
                size: selectedFile.size,
                hasYouTubeStream: selectedFile.hasYouTubeStream,
                songFilename: selectedFile.songFilename,
                artist: selectedFile.artist,
                song: selectedFile.song,
                author: selectedFile.author,
                difficulty: selectedFile.difficulty,
                bpm: selectedFile.bpm
            }
        });
    } catch (error) {
        logger.error('Failed to process level selection:', {
            error: error instanceof Error ? {
                message: error.message,
                stack: error.stack
            } : error,
            submissionId: parsedSubmissionId,
            selectedLevel,
            userId: req.user?.id,
            timestamp: new Date().toISOString()
        });

        if (error instanceof CdnError) {
            return res.status(400).json({
                success: false,
                error: error.message,
                code: error.code,
                details: error.details
            });
        }

        return res.status(500).json({
            success: false,
            error: 'Failed to process level selection'
        });
    }
});

export default router;
