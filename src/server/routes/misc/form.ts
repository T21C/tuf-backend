import express, {Request, Response, Router} from 'express';
import {Auth} from '../../middleware/auth.js';
import LevelSubmission from '../../../models/submissions/LevelSubmission.js';
import {
  PassSubmission,
  PassSubmissionJudgements,
  PassSubmissionFlags,
} from '../../../models/submissions/PassSubmission.js';
import {levelSubmissionHook, passSubmissionHook} from '../webhooks/webhook.js';
import Level from '../../../models/levels/Level.js';
import Difficulty from '../../../models/levels/Difficulty.js';
import LevelCredit from '../../../models/levels/LevelCredit.js';
import Creator from '../../../models/credits/Creator.js';
import {sseManager} from '../../../misc/utils/server/sse.js';
import {getScoreV2} from '../../../misc/utils/pass/CalcScore.js';
import {calcAcc} from '../../../misc/utils/pass/CalcAcc.js';
import LevelSubmissionCreatorRequest from '../../../models/submissions/LevelSubmissionCreatorRequest.js';
import LevelSubmissionTeamRequest from '../../../models/submissions/LevelSubmissionTeamRequest.js';
import LevelSubmissionSongRequest from '../../../models/submissions/LevelSubmissionSongRequest.js';
import LevelSubmissionArtistRequest from '../../../models/submissions/LevelSubmissionArtistRequest.js';
import LevelSubmissionEvidence from '../../../models/submissions/LevelSubmissionEvidence.js';
import sequelize from '../../../config/db.js';
import Song from '../../../models/songs/Song.js';
import Artist from '../../../models/artists/Artist.js';
import EvidenceService from '../../services/EvidenceService.js';
import { Transaction } from 'sequelize';
import { logger } from '../../services/LoggerService.js';
import Pass from '../../../models/passes/Pass.js';
import Judgement from '../../../models/passes/Judgement.js';
import cdnService from '../../services/CdnService.js';
import { CdnError } from '../../services/CdnService.js';
import { CDN_CONFIG } from '../../../externalServices/cdnService/config.js';
import multer from 'multer';
import fs from 'fs';
import { OAuthProvider, User } from '../../../models/index.js';
import Player from '../../../models/players/Player.js';
import { safeTransactionRollback } from '../../../misc/utils/Utility.js';
import { hasFlag } from '../../../misc/utils/auth/permissionUtils.js';
import { permissionFlags } from '../../../config/constants.js';

const router: Router = express.Router();
const evidenceService = EvidenceService.getInstance();


// Enhanced input validation and sanitization
const sanitizeTextInput = (input: string | null | undefined, maxLength = 1000): string => {
  if (input === null || input === undefined) return '';
  return input.trim().slice(0, maxLength);
};

// Validate date input
const validateDateInput = (input: any): Date | null => {
  if (!input) return null;
  const date = new Date(input);
  // Check for Invalid Date
  if (isNaN(date.getTime())) return null;
  // Reject dates too far in the past (before 2020) or future (more than 1 day ahead)
  const minDate = new Date('2020-01-01');
  const maxDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
  if (date < minDate || date > maxDate) return null;
  return date;
};

const validateNumericInput = (input: any, min = 0, max: number = Number.MAX_SAFE_INTEGER): number => {
  const parsed = parseInt(input?.toString() || '0');
  if (isNaN(parsed)) return min;
  return Math.max(min, Math.min(max, parsed));
};

const validateFloatInput = (input: any, min = 0, max: number = Number.MAX_SAFE_INTEGER): number => {
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

// Configure multer for evidence uploads (in addition to levelZip)
const uploadWithEvidence = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
      cb(null, file.originalname);
    }
  }),
  limits: {
    fileSize: 1000 * 1024 * 1024 // 1GB limit for levelZip
  }
}).fields([
  { name: 'levelZip', maxCount: 1 },
  { name: 'evidence', maxCount: 10 }
]);

// Form submission endpoint
router.post(
  '/form-submit',
  Auth.user(),
  uploadWithEvidence,
  express.json(),
  async (req: Request, res: Response) => {
    let transaction: Transaction | undefined;
    let uploadedFileId: string | null = null;

    try {
      // Start a transaction
      transaction = await sequelize.transaction();

      // Enhanced user validation
      if (!req.user) {
        throw {code: 401, error: 'User not authenticated'};
      }

      if (hasFlag(req.user, permissionFlags.BANNED)) {
        throw {code: 403, error: 'You are banned'};
      }

      if (hasFlag(req.user, permissionFlags.SUBMISSIONS_PAUSED)) {
        throw {code: 403, error: 'Your submissions are paused'};
      }

      if (!hasFlag(req.user, permissionFlags.EMAIL_VERIFIED)) {
        throw {code: 403, error: 'Your email is not verified'};
      }

      const formType = req.headers['x-form-type'];
      if (formType === 'level') {
        // Validate required fields for level submission
        const requiredFields = ['artist', 'song', 'diff', 'videoLink'];
        for (const field of requiredFields) {
          if (!req.body[field] || typeof req.body[field] !== 'string' || req.body[field].trim().length === 0) {
            throw {code: 400, error: `Missing or invalid required field: ${field}`};
          }
        }

        // Validate directDL if provided
        if (req.body.directDL && req.body.directDL.startsWith(CDN_CONFIG.baseUrl)) {
          throw {code: 400, error: 'Direct download cannot point to local CDN', details: {directDL: req.body.directDL}};
        }

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
          throw {code: 400, error: "You've already submitted this level, please wait for approval."};
        }

        // Handle level zip file if present
        let directDL: string | null = null;
        let levelFiles: any[] = [];
        const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;
        const levelZipFile = files?.levelZip?.[0];

        if (levelZipFile) {
          try {
            // Validate file size
            if (levelZipFile.size > 1000 * 1024 * 1024) { // 1GB
              throw {code: 400, error: 'File size exceeds maximum allowed size (1GB)'};
            }

            // Get uploadId from request body for progress tracking
            const uploadId = req.body.uploadId;

            // Send initial progress update if uploadId is provided
            if (uploadId) {
              sseManager.sendToSource(`levelUpload:${uploadId}`, {
                type: 'levelUploadProgress',
                data: {
                  uploadId,
                  status: 'processing',
                  progressPercent: 10,
                  currentStep: 'Uploading file...'
                }
              });
            }

            // Read file from disk instead of using buffer
            const fileBuffer = await fs.promises.readFile(levelZipFile.path);

            // Send progress update: processing
            if (uploadId) {
              sseManager.sendToSource(`levelUpload:${uploadId}`, {
                type: 'levelUploadProgress',
                data: {
                  uploadId,
                  status: 'processing',
                  progressPercent: 50,
                  currentStep: 'Processing zip file...'
                }
              });
            }

            const uploadResult = await cdnService.uploadLevelZip(
              fileBuffer,
              levelZipFile.originalname,
              uploadId
            );

            // Send progress update: caching
            if (uploadId) {
              sseManager.sendToSource(`levelUpload:${uploadId}`, {
                type: 'levelUploadProgress',
                data: {
                  uploadId,
                  status: 'caching',
                  progressPercent: 90,
                  currentStep: 'Populating cache...'
                }
              });
            }

            // Store fileId for potential cleanup
            uploadedFileId = uploadResult.fileId;

            // Clean up the temporary file
            try {
              if (levelZipFile.path) {
                await fs.promises.unlink(levelZipFile.path);
              }
            } catch (error) {
              // Ignore cleanup errors
            }

            // Get the level files from the CDN service
            levelFiles = await cdnService.getLevelFiles(uploadResult.fileId);

            // Send completion progress update if uploadId is provided
            if (uploadId) {
              sseManager.sendToSource(`levelUpload:${uploadId}`, {
                type: 'levelUploadProgress',
                data: {
                  uploadId,
                  status: 'completed',
                  progressPercent: 100,
                  currentStep: 'Upload complete!'
                }
              });
            }

            // If only one level file, use it directly
            directDL = `${CDN_CONFIG.baseUrl}/${uploadResult.fileId}`;
          } catch (error) {
            if (uploadedFileId) {
              await cleanUpCdnFile(uploadedFileId);
            }
            throw {code: 400, error: 'Failed to upload zip file to CDN', details: {error: error instanceof Error ? error.message : String(error)}};
          }
        }

        // Handle song/artist normalization
        const songName = sanitizeTextInput(req.body.song);
        const artistName = sanitizeTextInput(req.body.artist);
        const isNewSongRequest = req.body.isNewSongRequest === true || req.body.isNewSongRequest === 'true';
        const isNewArtistRequest = req.body.isNewArtistRequest === true || req.body.isNewArtistRequest === 'true';
        // New songs always require evidence
        const requiresSongEvidence = isNewSongRequest || (req.body.requiresSongEvidence === true || req.body.requiresSongEvidence === 'true');
        const requiresArtistEvidence = req.body.requiresArtistEvidence === true || req.body.requiresArtistEvidence === 'true';

        // Set songId: null if new request, otherwise validate and use provided ID
        let songId: number | null = null;
        if (!isNewSongRequest && req.body.songId) {
          const parsedSongId = parseInt(req.body.songId);
          if (!isNaN(parsedSongId) && parsedSongId > 0) {
            // Validate that the song exists
            const song = await Song.findByPk(parsedSongId, { transaction });
            if (!song) {
              throw {code: 400, error: `Song with ID ${parsedSongId} does not exist`};
            }
            songId = parsedSongId;
          }
        }

        // Set artistId: null if new request, otherwise validate and use provided ID
        let artistId: number | null = null;
        if (!isNewArtistRequest && req.body.artistId) {
          const parsedArtistId = parseInt(req.body.artistId);
          if (!isNaN(parsedArtistId) && parsedArtistId > 0) {
            // Validate that the artist exists
            const artist = await Artist.findByPk(parsedArtistId, { transaction });
            if (!artist) {
              throw {code: 400, error: `Artist with ID ${parsedArtistId} does not exist`};
            }
            artistId = parsedArtistId;
          }
        }

        // Handle suffix - normalize to null if empty string
        const suffix = req.body.suffix && typeof req.body.suffix === 'string'
          ? sanitizeTextInput(req.body.suffix).trim() || null
          : null;

        const submission = await LevelSubmission.create({
          artist: artistName,
          song: songName,
          suffix: suffix,
          songId: songId,
          artistId: artistId,
          diff: sanitizeTextInput(req.body.diff),
          videoLink: cleanVideoUrl(req.body.videoLink),
          directDL: directDL || sanitizeTextInput(req.body.directDL) || '',
          userId: req.user?.id,
          wsLink: sanitizeTextInput(req.body.wsLink) || '',
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

        // Create song request record if needed
        // New songs always require evidence and are initially pending
        let songRequestId: number | null = null;
        if (isNewSongRequest || songId || requiresSongEvidence) {
          const songRequest = await LevelSubmissionSongRequest.create({
            submissionId: submission.id,
            songId: songId,
            songName: isNewSongRequest ? songName : null,
            isNewRequest: isNewSongRequest,
          }, { transaction });
          songRequestId = songRequest.id;
          await submission.update({ songRequestId: songRequest.id }, { transaction });
        }

        // Create artist request records (multiple artists supported)
        const parsedArtistRequests = safeParseJSON(req.body.artistRequests);
        let artistRequestId: number | null = null;

        if (Array.isArray(parsedArtistRequests) && parsedArtistRequests.length > 0) {
          // Create multiple artist requests
          const createdRequests = await Promise.all(parsedArtistRequests.map(async (request: any) => {
            return LevelSubmissionArtistRequest.create({
              submissionId: submission.id,
              artistId: request.artistId || null,
              artistName: request.artistName ? sanitizeTextInput(request.artistName) : null,
              isNewRequest: request.isNewRequest || false,
              verificationState: request.verificationState || 'pending'
            }, { transaction });
          }));

          // Use first request ID for backward compatibility
          if (createdRequests.length > 0) {
            artistRequestId = createdRequests[0].id;
          }
        } else if (isNewArtistRequest || artistId || requiresArtistEvidence) {
          // Fallback: Create single artist request for backward compatibility
          const artistRequest = await LevelSubmissionArtistRequest.create({
            submissionId: submission.id,
            artistId: artistId,
            artistName: isNewArtistRequest ? artistName : null,
            isNewRequest: isNewArtistRequest,
            verificationState: req.body.verificationState || 'pending'
          }, { transaction });
          artistRequestId = artistRequest.id;
        }

        if (artistRequestId) {
          await submission.update({ artistRequestId: artistRequestId }, { transaction });
        }

        // Handle evidence image uploads (up to 10 images)
        const evidenceFiles = files?.evidence || [];

        // Evidence is required when new song/artist requests exist
        const requiresEvidence = requiresSongEvidence || requiresArtistEvidence;
        if (requiresEvidence && evidenceFiles.length === 0) {
          throw {code: 400, error: 'Evidence is required for new song/artist requests'};
        }

        if (evidenceFiles.length > 0 && evidenceFiles.length <= 10) {
          const evidenceType = req.body.evidenceType || 'song'; // 'song' or 'artist'
          // For artist evidence, use the first artist request ID if multiple exist
          const requestId = evidenceType === 'song' ? songRequestId : artistRequestId;

          // Upload evidence images
          const evidenceBuffers = await Promise.all(
            evidenceFiles.map((file: Express.Multer.File) => fs.promises.readFile(file.path))
          );

          await evidenceService.uploadEvidenceImages(
            submission.id,
            evidenceFiles.map((file: Express.Multer.File, idx: number) => ({
              buffer: evidenceBuffers[idx],
              originalname: file.originalname,
              mimetype: file.mimetype,
              size: file.size,
              fieldname: file.fieldname
            } as Express.Multer.File)),
            evidenceType as 'song' | 'artist',
            requestId || null,
            transaction // Pass transaction to avoid lock timeout
          );

          // Clean up temporary files
          for (const file of evidenceFiles) {
            try {
              if (file.path) {
                await fs.promises.unlink(file.path);
              }
            } catch (error) {
              // Ignore cleanup errors
            }
          }
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
              model: LevelSubmissionSongRequest,
              as: 'songRequest'
            },
            {
              model: LevelSubmissionArtistRequest,
              as: 'artistRequests'
            },
            {
              model: LevelSubmissionEvidence,
              as: 'evidence'
            },
            {
              model: User,
              as: 'levelSubmitter',
              attributes: ['id', 'username', 'playerId', 'nickname', 'avatarUrl'],
              include: [
                {
                  model: OAuthProvider,
                  as: 'providers',
                  required: false,
                  where: {
                    provider: 'discord'
                  }
                }
              ]
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
            throw {code: 400, error: `Missing or invalid required field: ${field}`};
          }
        }

        // Validate levelId is a valid number
        const levelId = parseInt(req.body.levelId);
        if (isNaN(levelId) || levelId <= 0) {
          throw {code: 400, error: 'Invalid level ID'};
        }

        // Enhanced judgement validation with proper bounds
        const sanitizedJudgements = {
          earlyDouble: validateNumericInput(req.body.earlyDouble, 0, 999999999),
          earlySingle: validateNumericInput(req.body.earlySingle, 0, 999999999),
          ePerfect: validateNumericInput(req.body.ePerfect, 0, 999999999),
          perfect: validateNumericInput(req.body.perfect, 0, 999999999), // Must be at least 1
          lPerfect: validateNumericInput(req.body.lPerfect, 0, 999999999),
          lateSingle: validateNumericInput(req.body.lateSingle, 0, 999999999),
          lateDouble: validateNumericInput(req.body.lateDouble, 0, 999999999),
        };

        // Validate speed if provided
        const speed = req.body.speed ? validateFloatInput(req.body.speed, 1, 100) : 1;

        // Validate rawTime
        const rawTime = validateDateInput(req.body.rawTime);
        if (!rawTime) {
          throw {code: 400, error: 'Invalid or missing rawTime - must be a valid date between 2020 and now'};
        }

        // Normalize boolean flags (handle both string and boolean inputs)
        const is12K = req.body.is12K === true || req.body.is12K === 'true';
        const isNoHoldTap = req.body.isNoHoldTap === true || req.body.isNoHoldTap === 'true';
        const is16K = req.body.is16K === true || req.body.is16K === 'true';

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
          throw {code: 404, error: 'Level not found'};
        }
        if (!level.difficulty) {
          throw {code: 404, error: 'Difficulty not found'};
        }

        // Normalize passerRequest early for existing submission check
        const passerRequestValue = req.body.passerRequest === true || req.body.passerRequest === 'true';

        const existingSubmission = await PassSubmission.findOne({
          where: {
            levelId: levelId,
            speed: speed,
            passer: sanitizeTextInput(req.body.passer),
            passerRequest: passerRequestValue,
            title: sanitizeTextInput(req.body.title),
            videoLink: cleanVideoUrl(req.body.videoLink),
            rawTime: rawTime,
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
              is12K,
              isNoHoldTap,
              is16K,
            },
            transaction
          });
        }

        if (existingSubmissionJudgements && existingSubmissionFlags) {
          throw {code: 400, error: 'Identical submission already exists', details: {levelId: levelId, speed: speed, videoLink: cleanVideoUrl(req.body.videoLink)}};
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
            is12K,
            isNoHoldTap,
            is16K,
          },
          transaction
        }) : null;

        if (existingPass) {
          throw {code: 400,
            error: 'A pass with identical video, judgements, and flags already exists for this level and speed',
            details: {
              levelId: levelId,
              speed: speed,
              videoLink: cleanVideoUrl(req.body.videoLink),
              title: sanitizeTextInput(req.body.title),
            }
          };
        }

        // Create properly structured level data for score calculation
        const levelData = {
          baseScore: level.baseScore,
          ppBaseScore: level.ppBaseScore,
          difficulty: level.difficulty,
        };

        const score = getScoreV2(
          {
            speed: speed,
            judgements: sanitizedJudgements,
            isNoHoldTap,
          },
          levelData,
        );

        // Validate that score is a valid number
        if (!Number.isFinite(score)) {
          throw {code: 400,
            error: 'Invalid judgement values - could not calculate score',
            details: {judgements: sanitizedJudgements, speed, levelId}
          };
        }

        const accuracy = calcAcc(sanitizedJudgements);

        // Validate that accuracy is a valid number
        if (!Number.isFinite(accuracy)) {
          throw {code: 400,
            error: 'Invalid judgement values - could not calculate accuracy',
            details: {judgements: sanitizedJudgements}
          };
        }

        // Validate passerId if provided (should be a positive integer or null)
        let passerId: number | null = null;
        if (req.body.passerId !== undefined && req.body.passerId !== null && req.body.passerId !== '') {
          passerId = parseInt(req.body.passerId);
          if (isNaN(passerId) || passerId <= 0) {
            throw {code: 400, error: 'Invalid passerId - must be a positive integer'};
          }
        }

        // Create the pass submission within transaction
        const submission = await PassSubmission.create({
          levelId: levelId,
          speed: speed,
          scoreV2: score,
          accuracy,
          passer: sanitizeTextInput(req.body.passer),
          passerId: passerId,
          passerRequest: passerRequestValue,
          feelingDifficulty: sanitizeTextInput(req.body.feelingDifficulty),
          title: sanitizeTextInput(req.body.title),
          videoLink: cleanVideoUrl(req.body.videoLink),
          rawTime,
          status: 'pending',
          assignedPlayerId: !passerRequestValue ? passerId : null,
          userId: req.user?.id,
        }, { transaction });

        await PassSubmissionJudgements.create({
          ...sanitizedJudgements,
          passSubmissionId: submission.id,
        }, { transaction });

        // Create flags with proper validation
        const flags = {
          passSubmissionId: submission.id,
          is12K,
          isNoHoldTap,
          is16K,
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
                {
                  model: LevelCredit,
                  as: 'levelCredits',
                  include: [{
                    model: Creator,
                    as: 'creator',
                  }],
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
                },
                {
                  model: OAuthProvider,
                  as: 'providers',
                  required: false,
                  where: {
                    provider: 'discord'
                  }
                }
              ]
            }
          ],
          transaction
        });

        if (!passObj) {
          throw {code: 500, error: 'Failed to create pass submission'};
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

      throw {code: 400, error: 'Invalid form type'};
    } catch (error: any) {
      // Enhanced error handling with proper cleanup

      if (!error.code || error.code === 500 ) {
        logger.error('Submission error:', error);
      }

      // Clean up uploaded CDN file if transaction failed
      if (uploadedFileId) {
        await cleanUpCdnFile(uploadedFileId);
      }

      // Clean up any uploaded files
      const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;
      if (files) {
        for (const fileArray of Object.values(files)) {
          for (const file of fileArray) {
            try {
              if (file.path) {
                await fs.promises.unlink(file.path);
              }
            } catch (error) {
              // Ignore cleanup errors
            }
          }
        }
      }

      // Only attempt rollback if transaction exists
      if (transaction) {
        try {
          await safeTransactionRollback(transaction);
        } catch (rollbackError) {
          // If rollback fails, it likely means the transaction was already rolled back
          logger.warn('Transaction rollback failed:', rollbackError);
        }
      }

      // Ensure error.code is a valid numeric HTTP status code
      // CdnError and other errors may have string codes (e.g., "UPLOAD_ERROR")
      const statusCode = (typeof error.code === 'number' && error.code >= 100 && error.code < 600) 
        ? error.code 
        : 500;
      
      return res.status(statusCode).json({
        error: error.error || 'Failed to process submission',
        details: error.details || {},
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

        if (!submission.directDL || !submission.directDL.includes('/')) {
            return res.status(400).json({
                success: false,
                error: 'Invalid directDL URL',
                directDL: submission.directDL
            });
        }

        // Extract fileId from CDN URL (could be /api/{fileId} or /cdn/levels/{fileId})
        const urlParts = submission.directDL.split('/');
        const fileId = urlParts[urlParts.length - 1] || '';
        if (!fileId) {
            return res.status(400).json({
                success: false,
                error: 'Invalid directDL URL - could not extract file ID',
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
