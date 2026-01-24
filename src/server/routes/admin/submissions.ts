import {Request, Response, Router} from 'express';
import {Auth} from '../../middleware/auth.js';
import {
  PassSubmission,
  PassSubmissionFlags,
  PassSubmissionJudgements,
} from '../../../models/submissions/PassSubmission.js';
import Pass from '../../../models/passes/Pass.js';
import Level from '../../../models/levels/Level.js';
import Difficulty from '../../../models/levels/Difficulty.js';
import Judgement from '../../../models/passes/Judgement.js';
import {calcAcc} from '../../../misc/utils/pass/CalcAcc.js';
import {getScoreV2} from '../../../misc/utils/pass/CalcScore.js';
import {getIO} from '../../../misc/utils/server/socket.js';
import sequelize from '../../../config/db.js';
import {sseManager} from '../../../misc/utils/server/sse.js';
import {PlayerStatsService} from '../../services/PlayerStatsService.js';
import {updateWorldsFirstStatus} from '../database/passes/index.js';
import {IPassSubmissionJudgements} from '../../interfaces/models/index.js';
import LevelSubmission from '../../../models/submissions/LevelSubmission.js';
import Rating from '../../../models/levels/Rating.js';
import Player from '../../../models/players/Player.js';
import Team from '../../../models/credits/Team.js';
import LevelSubmissionCreatorRequest from '../../../models/submissions/LevelSubmissionCreatorRequest.js';
import LevelSubmissionTeamRequest from '../../../models/submissions/LevelSubmissionTeamRequest.js';
import Creator from '../../../models/credits/Creator.js';
import LevelCredit from '../../../models/levels/LevelCredit.js';
import User from '../../../models/auth/User.js';
import { Op } from 'sequelize';
import { logger } from '../../services/LoggerService.js';
import ElasticsearchService from '../../services/ElasticsearchService.js';
import { CDN_CONFIG } from '../../../externalServices/cdnService/config.js';
import cdnService from '../../services/CdnService.js';
import { safeTransactionRollback } from '../../../misc/utils/Utility.js';
import {TeamAlias} from '../../../models/credits/TeamAlias.js';
import {tagAssignmentService} from '../../services/TagAssignmentService.js';
import LevelSubmissionSongRequest from '../../../models/submissions/LevelSubmissionSongRequest.js';
import LevelSubmissionArtistRequest from '../../../models/submissions/LevelSubmissionArtistRequest.js';
import LevelSubmissionEvidence from '../../../models/submissions/LevelSubmissionEvidence.js';
import Song from '../../../models/songs/Song.js';
import Artist from '../../../models/artists/Artist.js';
import SongCredit from '../../../models/songs/SongCredit.js';
import SongService from '../../services/SongService.js';
import ArtistService from '../../services/ArtistService.js';
import EvidenceService from '../../services/EvidenceService.js';
import submissionSongArtistRoutes from './submissions-song-artist.js';

const router: Router = Router();
const playerStatsService = PlayerStatsService.getInstance();
const elasticsearchService = ElasticsearchService.getInstance();
const songService = SongService.getInstance();
const artistService = ArtistService.getInstance();
const evidenceService = EvidenceService.getInstance();

enum CreditRole {
  CHARTER = 'charter',
  VFXER = 'vfxer',
  TEAM = 'team'
}

/**
 * Extracts meaningful error information from Sequelize/database errors
 */
function extractErrorDetails(error: unknown): {
  message: string;
  sql?: string;
  original?: string;
  fields?: Record<string, unknown>;
} {
  if (error instanceof Error) {
    const seqError = error as any;
    return {
      message: error.message,
      sql: seqError.sql,
      original: seqError.original?.message || seqError.parent?.message,
      fields: seqError.fields,
    };
  }
  return { message: String(error) };
}

/**
 * Validates a number is finite and not NaN
 */
function isValidNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && !Number.isNaN(value);
}

interface CreditStats {
  charterCount: number;
  vfxerCount: number;
  totalCredits: number;
}

interface CreatorCredit {
  role: string;
  levelId: number;
  creatorId: number;
  id: number;
}

interface CreatorWithCredits {
  credits?: CreatorCredit[];
  id: number;
  name: string;
}

interface CreatorRequest {
  creator?: CreatorWithCredits;
}

// Get all level submissions
router.get('/levels', Auth.superAdmin(), async (req: Request, res: Response) => {
    try {
      const levelSubmissions = await LevelSubmission.findAll();
      return res.json(levelSubmissions);
    } catch (error) {
      logger.error('Error fetching level submissions:', error);
      return res.status(500).json({error: 'Failed to fetch level submissions'});
    }
  },
);

// Get pending level submissions
router.get('/levels/pending', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    const pendingLevelSubmissions = await LevelSubmission.findAll({
      where: { status: 'pending' },
      include: [
        {
          model: LevelSubmissionCreatorRequest,
          as: 'creatorRequests',
          include: [
            {
              model: Creator,
              as: 'creator',
              include: [
                {
                  model: LevelCredit,
                  as: 'credits',
                  required: false
                }
              ]
            }
          ]
        },
        {
          model: LevelSubmissionTeamRequest,
          as: 'teamRequestData',
          include: [
            {
              model: Team,
              as: 'team',
              include: [
                {
                  model: Level,
                  as: 'levels',
                  required: false
                },
                {
                  model: TeamAlias,
                  as: 'teamAliases',
                  required: false
                }
              ]
            }
          ]
        },
        {
          model: LevelSubmissionSongRequest,
          as: 'songRequest',
          include: [
            {
              model: Song,
              as: 'song'
            }
          ]
        },
        {
          model: LevelSubmissionArtistRequest,
          as: 'artistRequests',
          include: [
            {
              model: Artist,
              as: 'artist'
            }
          ]
        },
        {
          model: LevelSubmissionEvidence,
          as: 'evidence'
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
        },
        {
          model: Artist,
          as: 'artistObject'
        },
        {
          model: User,
          as: 'levelSubmitter',
          required: false,
          attributes: ['id', 'username', 'playerId']
        }
      ]
    });

    const submissionsWithStats = pendingLevelSubmissions.map(submission => {
      const submissionData = submission.toJSON();

      // Process creator requests
      submissionData.creatorRequests = submissionData.creatorRequests?.map((request: CreatorRequest) => {
        if (request.creator?.credits) {
          const credits = request.creator.credits;
          const creditStats: CreditStats = {
            charterCount: credits.filter((credit: CreatorCredit) => credit.role === 'charter').length,
            vfxerCount: credits.filter((credit: CreatorCredit) => credit.role === 'vfxer').length,
            totalCredits: credits.length
          };
          (request.creator as any).credits = creditStats;
        }
        return request;
      });

      // Process team request data
      if (submissionData.teamRequestData?.team) {
        const team = submissionData.teamRequestData.team;
        team.credits = {
          totalLevels: team.levels?.length || 0,
          verifiedLevels: team.levels?.filter((l: any) => l.isVerified).length || 0,
          memberCount: team.members?.length || 0
        };
        // Clean up levels array to avoid sending too much data
        delete team.levels;
      }

      return submissionData;
    });

    return res.json(submissionsWithStats);
  } catch (error) {
    logger.error('Error fetching pending level submissions:', error);
    return res.status(500).json({ error: 'Failed to fetch pending level submissions' });
  }
});

// Get all pass submissions
router.get('/passes', Auth.superAdmin(), async (req: Request, res: Response) => {
    try {
      const passSubmissions = await PassSubmission.findAll({
        include: [
          {
            model: PassSubmissionJudgements,
            as: 'judgements',
          },
          {
            model: PassSubmissionFlags,
            as: 'flags',
          },
        ],
      });
      return res.json(passSubmissions);
    } catch (error) {
      logger.error('Error fetching pass submissions:', error);
      return res.status(500).json({error: 'Failed to fetch pass submissions'});
    }
  },
);

// Get pending pass submissions
router.get('/passes/pending', Auth.superAdmin(), async (req: Request, res: Response) => {
    try {
      const submissions = await PassSubmission.findAll({
        where: {status: 'pending'},
        include: [
          {
            model: Player,
            as: 'assignedPlayer',
          },
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
            required: false,
            attributes: ['id', 'username', 'playerId']
          }
        ],
        order: [['createdAt', 'DESC']],
      });
      return res.json(submissions);
    } catch (error) {
      logger.error('Error fetching pending pass submissions:', error);
      return res
        .status(500)
        .json({error: 'Failed to fetch pending pass submissions'});
    }
  },
);

// Handle level submission actions (approve/reject)
router.put('/levels/:id/approve', Auth.superAdmin(), async (req: Request, res: Response) => {
    const transaction = await sequelize.transaction();
    let rollbackReason = '';
    try {
      const {id} = req.params;
        const submissionObj = await LevelSubmission.findOne({
          where: {[Op.and]: [{id}, {status: 'pending'}]},
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
              model: Song,
              as: 'songObject'
            },
            {
              model: Artist,
              as: 'artistObject'
            }
          ],
          transaction,
        });

        if (!submissionObj) {
          rollbackReason = 'Submission not found';
          await safeTransactionRollback(transaction, logger);
          return res.status(404).json({error: 'Submission not found'});
        }

        // Check if all creator requests are either assigned or marked as new
        const hasUnhandledCreators = submissionObj.creatorRequests?.some(
          (request) => !request.creatorId && !request.isNewRequest
        );

        if (hasUnhandledCreators) {
          rollbackReason = 'All creators must be either assigned to existing creators or marked as new creators';
          await safeTransactionRollback(transaction, logger);
          return res.status(400).json({
            error: 'All creators must be either assigned to existing creators or marked as new creators'
          });
        }

        // Check if team request is properly handled
        if (submissionObj.teamRequestData && !submissionObj.teamRequestData.teamId && !submissionObj.teamRequestData.isNewRequest) {
          rollbackReason = 'Team must be either assigned to an existing team or marked as a new team';
          await safeTransactionRollback(transaction, logger);
          return res.status(400).json({
            error: 'Team must be either assigned to an existing team or marked as a new team'
          });
        }

        const submission = submissionObj.dataValues;

        // Get first charter and vfxer from creator requests
        const firstCharter = submission.creatorRequests?.find((r: LevelSubmissionCreatorRequest) => r.role === 'charter');
        const firstVfxer = submission.creatorRequests?.find((r: LevelSubmissionCreatorRequest) => r.role === 'vfxer');

        // Check if credits are simple (no brackets or parentheses)
        const complexChars = ['[', '(', '{', '}', ']', ')'];
        const hasSimpleCredits = !complexChars.some(
          char =>
            (firstCharter?.creatorName || '').includes(char) ||
            (firstVfxer?.creatorName || '').includes(char),
        );

        // Handle team request
        let teamId = null;
        let team = null;
        // Only process team if there is a team request
        if (submission.teamRequestData) {
          if (submission.teamRequestData.teamId) {
            // Use existing team
            team = await Team.findByPk(submission.teamRequestData.teamId, { transaction });
            if (!team) {
              rollbackReason = 'Referenced team not found';
              await safeTransactionRollback(transaction, logger);
              return res.status(404).json({ error: 'Referenced team not found' });
            }
            teamId = team.id;
          } else if (submission.teamRequestData.isNewRequest) {
            // Create new team
            [team] = await Team.findOrCreate({
              where: { name: submission.teamRequestData.teamName.trim() },
              transaction,
            });
            teamId = team.id;
          }
        }

        // Check if all existing creators are verified
        const existingCreatorIds = submission.creatorRequests
          ?.filter((r: LevelSubmissionCreatorRequest) => r.creatorId)
          .map((r: LevelSubmissionCreatorRequest) => r.creatorId);

        const existingCreators = await Creator.findAll({
          where: {
            id: existingCreatorIds
          },
          transaction
        });

        const allExistingCreatorsVerified = existingCreators.every((c: Creator) => c.isVerified);

        // Handle song request
        let finalSongId: number | null = null;
        if (submission.songRequest) {
          if (submission.songRequest.songId) {
            // Use existing song
            finalSongId = submission.songRequest.songId;
          } else if (submission.songRequest.isNewRequest && submission.songRequest.songName) {
            // Create new song (service methods don't support transactions yet)
            const song = await songService.findOrCreateSong(submission.songRequest.songName.trim());
            finalSongId = song.id;
          }
        } else if (submission.songId) {
          // Use songId directly from submission
          finalSongId = submission.songId;
        }

        // Handle artist requests (multiple artists supported)
        const finalArtistIds: number[] = [];
        
        if (submission.artistRequests && submission.artistRequests.length > 0) {
          // Process multiple artist requests
          for (const artistRequest of submission.artistRequests) {
            if (artistRequest.artistId) {
              // Use existing artist
              finalArtistIds.push(artistRequest.artistId);
            } else if (artistRequest.isNewRequest && artistRequest.artistName) {
              // Create new artist (service methods don't support transactions yet)
              const artist = await artistService.findOrCreateArtist(artistRequest.artistName.trim());
              finalArtistIds.push(artist.id);
            }
          }
        } else if (submission.artistId) {
          // Fallback: Use artistId directly from submission (backward compatibility)
          finalArtistIds.push(submission.artistId);
        }

        // If we have an existing song, verify all song credits match artist requests
        if (finalSongId && submission.songObject?.credits) {
          const songCreditArtistIds = submission.songObject.credits
            .map((credit: any) => credit.artist?.id)
            .filter((id: number | undefined): id is number => id !== undefined)
            .sort();
          
          const requestArtistIds = [...finalArtistIds].sort();
          
          // Verify that all song credits are represented in artist requests
          if (songCreditArtistIds.length !== requestArtistIds.length ||
              !songCreditArtistIds.every((id: number, idx: number) => id === requestArtistIds[idx])) {
            rollbackReason = 'Artist requests must match all song credits when an existing song is selected';
            await safeTransactionRollback(transaction, logger);
            return res.status(400).json({
              error: 'Artist requests must match all song credits when an existing song is selected'
            });
          }
        }

        // Create song credit relationships for all artists
        if (finalSongId && finalArtistIds.length > 0) {
          for (const artistId of finalArtistIds) {
            // Check if credit already exists
            const existingCredit = await SongCredit.findOne({
              where: {
                songId: finalSongId,
                artistId: artistId
              },
              transaction
            });

            if (!existingCredit) {
              await SongCredit.create({
                songId: finalSongId,
                artistId: artistId,
                role: null // Primary artist relationship
              }, { transaction });
            }
          }
        }
        
        // Use first artist for backward compatibility with artistId field
        const finalArtistId = finalArtistIds.length > 0 ? finalArtistIds[0] : null;

        const newLevel = await Level.create(
          {
            song: submission.song,
            artist: submission.artist,
            songId: finalSongId,
            charter: firstCharter?.creatorName || '',
            vfxer: firstVfxer?.creatorName || '',
            team: team?.name || '',
            videoLink: submission.videoLink,
            dlLink: submission.directDL,
            workshopLink: submission.wsLink,
            toRate: true,
            isDeleted: false,
            diffId: 0,
            baseScore: 0,
            isVerified: hasSimpleCredits && allExistingCreatorsVerified &&
                       !submission.creatorRequests?.some((r: LevelSubmissionCreatorRequest) => r.isNewRequest) &&
                       (!submission.teamRequestData || !submission.teamRequestData.isNewRequest),
            clears: 0,
            likes: 0,
            publicComments: '',
            rerateReason: '',
            rerateNum: '',
            previousDiffId: 0,
            isAnnounced: false,
            isHidden: false,
            teamId: teamId,
            isExternallyAvailable: false,
          },
          {transaction},
        );

        const lowRatingRegex = /^[pP]\d|^[1-9]$|^1[0-9]\+?$|^([1-9]|1[0-9]\+?)(~|-)([1-9]|1[0-9]\+?)$/;
        // Create rating since toRate is true
        await Rating.create(
          {
            levelId: newLevel.id,
            currentDifficultyId: 0,
            lowDiff: lowRatingRegex.test(submission.diff),
            requesterFR: submission.diff,
            averageDifficultyId: null,
          },
          {transaction},
        );

        // Create level credits for each creator request
        for (const request of submission.creatorRequests || []) {
          if (request.creatorId) {
            // Submitting user is the owner
            const isOwner = request.id === req.user?.creatorId;
            // For existing creators
            // Check if credit already exists
            const existingCredit = await LevelCredit.findOne({
              where: {
                levelId: newLevel.id,
                creatorId: request.creatorId,
                role: request.role
              },
              transaction
            });

            if (!existingCredit) {
              await LevelCredit.create({
                levelId: newLevel.id,
                creatorId: request.creatorId,
                role: request.role,
                isOwner: isOwner,
                isVerified: existingCreators.find((c: Creator) => c.id === request.creatorId)?.isVerified || false
              }, {
                transaction
              });
            }
          } 
          else if (request.isNewRequest) {
            // For new creators
            const [creator] = await Creator.findOrCreate({
              where: { name: request.creatorName.trim() },
              defaults: {
                isVerified: false
              },
              transaction
            });

            // Check if credit already exists
            const existingCredit = await LevelCredit.findOne({
              where: {
                levelId: newLevel.id,
                creatorId: creator.id,
                role: request.role
              },
              transaction
            });

            if (!existingCredit) {
              await LevelCredit.create({
                levelId: newLevel.id,
                creatorId: creator.id,
                role: request.role,
                isVerified: false
              }, {
                transaction
              });
            }
          }
        }

        await LevelSubmission.update(
          {status: 'approved', toRate: true},
          {
            where: {id},
            transaction,
          },
        );


        // Broadcast updates
        sseManager.broadcast({type: 'submissionUpdate'});
        sseManager.broadcast({type: 'levelUpdate'});
        sseManager.broadcast({
          type: 'submissionUpdate',
          data: {
            action: 'approve',
            submissionId: id,
            submissionType: 'level',
          },
        });

        // Move evidence from submission to song/artist if approved
        if (submission.evidence && submission.evidence.length > 0) {
          for (const evidence of submission.evidence) {
            if (evidence.type === 'song' && finalSongId) {
              await evidenceService.addEvidenceToSong(
                finalSongId,
                evidence.link,
                'other'
              );
            } else if (evidence.type === 'artist' && finalArtistId) {
              await evidenceService.addEvidenceToArtist(
                finalArtistId,
                evidence.link,
                'other'
              );
            }
          }
        }

        await transaction.commit();

        // Index the level in Elasticsearch after transaction is committed
        await elasticsearchService.indexLevel(newLevel);

        // Auto-assign tags based on level analysis
        try {
          const tagResult = await tagAssignmentService.assignAutoTags(newLevel.id);
          if (tagResult.assignedTags.length > 0) {
            logger.debug('Auto tags assigned to new level', {
              levelId: newLevel.id,
              assignedTags: tagResult.assignedTags,
            });
            // Reindex level to include new tags
            await elasticsearchService.reindexLevels([newLevel.id]);
          }
        } catch (tagError) {
          // Log error but don't fail the approval
          logger.warn('Failed to assign auto tags to new level:', {
            levelId: newLevel.id,
            error: tagError instanceof Error ? tagError.message : String(tagError),
          });
        }

        return res.json({
          message: 'Submission approved, level and rating created successfully',
        });
    } catch (error) {
      await safeTransactionRollback(transaction, logger);
      logger.error('Error approving level submission:', {error, submissionId: req.params.id, rollbackReason});
      return res
        .status(500)
        .json({error: 'Failed to process level submission'});
    }
  },
);


router.put('/levels/:id/decline', Auth.superAdmin(), async (req: Request, res: Response) => {
    const transaction = await sequelize.transaction();
    let rollbackReason = '';
    try {
      const {id} = req.params;

      // Get the submission to check if it has a level zip and evidence
      const submission = await LevelSubmission.findByPk(id, {
        include: [
          {
            model: LevelSubmissionEvidence,
            as: 'evidence'
          }
        ],
        transaction
      });
      if (!submission) {
        rollbackReason = 'Submission not found';
        await safeTransactionRollback(transaction, logger);
        return res.status(404).json({error: 'Submission not found'});
      }

      // Check if the directDL is a local CDN URL
      if (submission.directDL && submission.directDL.includes(CDN_CONFIG.baseUrl)) {
        // Extract fileId from URL (could be /api/{fileId} or /cdn/levels/{fileId})
        const urlParts = submission.directDL.split('/');
        const fileId = urlParts[urlParts.length - 1];
        if (fileId) {
          try {
            await cdnService.deleteFile(fileId);
          } catch (error) {
            logger.warn('Failed to delete CDN file on decline:', error);
          }
        }
      }

      // Delete all evidence images from CDN
      const submissionWithEvidence = submission as LevelSubmission & { evidence?: LevelSubmissionEvidence[] };
      if (submissionWithEvidence.evidence && submissionWithEvidence.evidence.length > 0) {
        await evidenceService.deleteAllEvidenceForSubmission(parseInt(id));
      }

      await LevelSubmission.update(
        {status: 'declined'},
        {
          where: {id},
          transaction,
        },
      );



      // Broadcast updates
      sseManager.broadcast({type: 'submissionUpdate'});
      sseManager.broadcast({
        type: 'submissionUpdate',
        data: {
          action: 'decline',
          submissionId: id,
          submissionType: 'level',
        },
      });

      await transaction.commit();

      return res.json({message: 'Submission declined successfully'});
    } catch (error) {
      await safeTransactionRollback(transaction, logger);
      logger.error('Error declining level submission:', {error, submissionId: req.params.id, rollbackReason});
      return res
        .status(500)
        .json({error: 'Failed to process level submission'});
    }
  },
);


// Split pass submission actions into specific endpoints
router.put('/passes/:id/approve', Auth.superAdmin(), async (req: Request, res: Response) => {
    const transaction = await sequelize.transaction();
    const submissionId = req.params.id;

    try {
      const submission = await PassSubmission.findOne({
        where: {[Op.and]: [{id: parseInt(submissionId)}, {status: 'pending'}]},
        include: [
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
            model: PassSubmissionFlags,
            as: 'flags',
          },
          {
            model: PassSubmissionJudgements,
            as: 'judgements',
          },
        ],
        transaction,
      });

      // === VALIDATION PHASE ===
      if (!submission) {
        await safeTransactionRollback(transaction, logger);
        return res.status(404).json({error: 'Submission not found or already processed'});
      }

      if (!submission.level) {
        await safeTransactionRollback(transaction, logger);
        logger.error('Pass submission missing level data', {
          submissionId,
          levelId: submission.levelId,
        });
        return res.status(400).json({error: 'Level data not found for this submission'});
      }

      if (!submission.level.difficulty) {
        await safeTransactionRollback(transaction, logger);
        logger.error('Pass submission level missing difficulty', {
          submissionId,
          levelId: submission.levelId,
        });
        return res.status(400).json({error: 'Level difficulty not found - level may need to be rated first'});
      }

      if (!submission.assignedPlayerId) {
        await safeTransactionRollback(transaction, logger);
        logger.error('Pass submission missing assigned player', { submissionId });
        return res.status(400).json({error: 'No player assigned to this submission'});
      }

      // Verify player exists
      const player = await Player.findByPk(submission.assignedPlayerId, { transaction });
      if (!player) {
        await safeTransactionRollback(transaction, logger);
        logger.error('Assigned player not found', {
          submissionId,
          playerId: submission.assignedPlayerId,
        });
        return res.status(400).json({error: 'Assigned player does not exist'});
      }

      if (!submission.judgements) {
        await safeTransactionRollback(transaction, logger);
        logger.error('Pass submission missing judgements', { submissionId });
        return res.status(400).json({error: 'Judgements data not found for this submission'});
      }

      if (!submission.flags) {
        await safeTransactionRollback(transaction, logger);
        logger.error('Pass submission missing flags', { submissionId });
        return res.status(400).json({error: 'Flags data not found for this submission'});
      }

      // Validate levelId
      if (!submission.levelId || !isValidNumber(submission.levelId)) {
        await safeTransactionRollback(transaction, logger);
        logger.error('Pass submission has invalid levelId', {
          submissionId,
          levelId: submission.levelId,
        });
        return res.status(400).json({error: 'Invalid level ID'});
      }

      // === CALCULATION PHASE ===
      const levelData = {
        baseScore: submission.level.baseScore,
        ppBaseScore: submission.level.ppBaseScore,
        difficulty: submission.level.difficulty,
      };

      const judgements = {
        earlyDouble: submission.judgements.earlyDouble || 0,
        earlySingle: submission.judgements.earlySingle || 0,
        ePerfect: submission.judgements.ePerfect || 0,
        perfect: submission.judgements.perfect || 0,
        lPerfect: submission.judgements.lPerfect || 0,
        lateSingle: submission.judgements.lateSingle || 0,
        lateDouble: submission.judgements.lateDouble || 0,
      };

      const speed = submission.speed || 1;
      const accuracy = calcAcc(judgements as IPassSubmissionJudgements);
      const scoreV2 = getScoreV2(
        {
          speed,
          judgements: judgements as IPassSubmissionJudgements,
          isNoHoldTap: submission.flags.isNoHoldTap || false,
        },
        levelData,
      );

      // Validate calculated values
      if (!isValidNumber(accuracy)) {
        await safeTransactionRollback(transaction, logger);
        logger.error('Calculated accuracy is invalid', {
          submissionId,
          accuracy,
          judgements,
        });
        return res.status(400).json({error: 'Failed to calculate valid accuracy from judgements'});
      }

      if (!isValidNumber(scoreV2)) {
        await safeTransactionRollback(transaction, logger);
        logger.error('Calculated scoreV2 is invalid', {
          submissionId,
          scoreV2,
          speed,
          baseScore: submission.level.baseScore,
          judgements,
        });
        return res.status(400).json({error: 'Failed to calculate valid score - check level base score and difficulty'});
      }

      // === CREATE PHASE ===
      const passData = {
        levelId: submission.levelId,
        playerId: submission.assignedPlayerId,
        speed,
        vidTitle: submission.title || '',
        videoLink: submission.videoLink,
        vidUploadTime: submission.rawTime || new Date(),
        is12K: submission.flags.is12K || false,
        is16K: submission.flags.is16K || false,
        isNoHoldTap: submission.flags.isNoHoldTap || false,
        feelingRating: submission.feelingDifficulty || null,
        accuracy,
        scoreV2,
        isAnnounced: false,
        isDeleted: false,
      };

      logger.debug('Creating pass with data', {
        submissionId,
        levelId: passData.levelId,
        playerId: passData.playerId,
        accuracy: passData.accuracy,
        scoreV2: passData.scoreV2,
      });

      const pass = await Pass.create(passData, { transaction });

      // Create judgements record
      const now = new Date();
      const judgementRecord = await Judgement.create(
        {
          id: pass.id,
          ...judgements,
          createdAt: now,
          updatedAt: now,
        },
        { transaction },
      );

      if (!judgementRecord) {
        throw new Error(`Failed to create judgement record for pass #${pass.id}`);
      }

      // Update submission status
      await submission.update(
        {
          status: 'approved',
          passId: pass.id,
        },
        { transaction },
      );

      // Update worlds first status if needed
      await updateWorldsFirstStatus(submission.levelId, transaction);

      // Fetch complete pass with associations
      const newPass = await Pass.findByPk(pass.id, {
        include: [
          {
            model: Player,
            as: 'player',
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
            model: Judgement,
            as: 'judgements',
          },
        ],
        transaction,
      });

      // Update player stats before committing
      let playerStats = null;
      if (submission.assignedPlayerId) {
        await playerStatsService.updatePlayerStats([submission.assignedPlayerId]);
        playerStats = (await playerStatsService.getPlayerStats(submission.assignedPlayerId))[0];
      }

      await transaction.commit();

      // Index in Elasticsearch after commit
      await elasticsearchService.indexPass(newPass!);
      await elasticsearchService.indexLevel(newPass!.level!);

      // Broadcast updates
      sseManager.broadcast({
        type: 'submissionUpdate',
        data: {
          action: 'create',
          submissionId: submission.id,
          submissionType: 'pass',
        },
      });

      if (submission.assignedPlayerId && playerStats) {
        sseManager.broadcast({
          type: 'passUpdate',
          data: {
            playerId: submission.assignedPlayerId,
            passedLevelId: submission.levelId,
            newScore: playerStats?.rankedScore || 0,
            action: 'create',
          },
        });
      }

      return res.json({
        message: 'Pass submission approved successfully',
        pass,
      });
    } catch (error) {
      await safeTransactionRollback(transaction, logger);
      const errorDetails = extractErrorDetails(error);
      logger.error('Error processing pass submission:', {
        submissionId,
        errorMessage: errorDetails.message,
        sqlQuery: errorDetails.sql,
        originalError: errorDetails.original,
        fields: errorDetails.fields,
      });
      return res.status(500).json({
        error: 'Failed to process pass submission',
        details: errorDetails.message,
      });
    }
  }
);

router.put('/passes/:id/decline', Auth.superAdmin(), async (req: Request, res: Response) => {
    const transaction = await sequelize.transaction();
    try {
      await PassSubmission.update(
        {status: 'declined'},
        {
          where: {id: parseInt(req.params.id)},
          transaction,
        }
      );

      // Broadcast updates
      sseManager.broadcast({type: 'submissionUpdate'});
      sseManager.broadcast({
        type: 'submissionUpdate',
        data: {
          action: 'decline',
          submissionId: req.params.id,
          submissionType: 'pass',
        },
      });

      await transaction.commit();

      return res.json({message: 'Pass submission rejected successfully'});
    } catch (error) {
      await safeTransactionRollback(transaction, logger);
      const errorDetails = extractErrorDetails(error);
      logger.error('Error declining pass submission:', {
        submissionId: req.params.id,
        errorMessage: errorDetails.message,
        sqlQuery: errorDetails.sql,
        originalError: errorDetails.original,
      });
      return res.status(500).json({
        error: 'Failed to decline pass submission',
        details: errorDetails.message,
      });
    }
  }
);

router.put('/passes/:id/assign-player', Auth.superAdmin(), async (req: Request, res: Response) => {
    const transaction = await sequelize.transaction();
    try {
      const {playerId} = req.body;
      const submission = await PassSubmission.findByPk(parseInt(req.params.id), {
        include: [
          {
            model: Player,
            as: 'assignedPlayer',
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
            model: PassSubmissionJudgements,
            as: 'judgements',
          },
          {
            model: PassSubmissionFlags,
            as: 'flags',
          },
        ],
        transaction,
      });

      if (!submission) {
        await safeTransactionRollback(transaction, logger);
        return res.status(404).json({error: 'Submission not found'});
      }

      await submission.update({assignedPlayerId: playerId}, {transaction});

      // Reload the submission to get the fresh player data
      await submission.reload({
        include: [
          {
            model: Player,
            as: 'assignedPlayer',
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
            model: PassSubmissionJudgements,
            as: 'judgements',
          },
          {
            model: PassSubmissionFlags,
            as: 'flags',
          },
        ],
        transaction,
      });

      // Broadcast the update
      sseManager.broadcast({
        type: 'submissionUpdate',
        data: {
          action: 'assign-player',
          submissionId: req.params.id,
          submissionType: 'pass',
        },
      });

      await transaction.commit();

      return res.json({
        message: 'Player assigned successfully',
        submission,
      });
    } catch (error) {
      await safeTransactionRollback(transaction, logger);
      const errorDetails = extractErrorDetails(error);
      logger.error('Error assigning player:', {
        submissionId: req.params.id,
        playerId: req.body.playerId,
        errorMessage: errorDetails.message,
        sqlQuery: errorDetails.sql,
        originalError: errorDetails.original,
      });
      return res.status(500).json({
        error: 'Failed to assign player',
        details: errorDetails.message,
      });
    }
  }
);

// Auto-approve pass submissions
router.post('/auto-approve/passes', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    // Find all pending submissions with assigned players and required data
    const pendingSubmissions = await PassSubmission.findAll({
      where: { status: 'pending' },
      include: [
        {
          model: Level,
          as: 'level',
          include: [
            { model: Difficulty, as: 'difficulty' },
            { model: LevelCredit, as: 'levelCredits', include: [{ model: Creator, as: 'creator' }] },
          ],
          required: true
        },
        {
          model: Player,
          as: 'assignedPlayer',
          required: true
        },
        {
          model: PassSubmissionFlags,
          as: 'flags',
          required: true
        },
        {
          model: PassSubmissionJudgements,
          as: 'judgements',
          required: true
        }
      ]
    });

    const results: Array<{
      id: number;
      success: boolean;
      error?: string;
      validationErrors?: string[];
    }> = [];

    for (const submission of pendingSubmissions) {
      const transaction = await sequelize.transaction();
      const validationErrors: string[] = [];

      try {
        // === VALIDATION PHASE ===
        if (!submission.flags) {
          validationErrors.push('Missing flags data');
        }
        if (!submission.judgements) {
          validationErrors.push('Missing judgements data');
        }
        if (!submission.level) {
          validationErrors.push('Missing level data');
        }
        if (submission.level && !submission.level.difficulty) {
          validationErrors.push('Level missing difficulty - may need rating');
        }
        if (!submission.assignedPlayerId) {
          validationErrors.push('No player assigned');
        }
        if (!submission.levelId || !isValidNumber(submission.levelId)) {
          validationErrors.push(`Invalid levelId: ${submission.levelId}`);
        }

        if (validationErrors.length > 0) {
          throw new Error(`Validation failed: ${validationErrors.join(', ')}`);
        }

        // TypeScript narrowing after validation
        const flags = submission.flags!;
        const judgements = submission.judgements!;
        const level = submission.level!;
        const difficulty = level.difficulty!;
        const playerId = submission.assignedPlayerId!;

        // === CALCULATION PHASE ===
        const judgementData = {
          earlyDouble: judgements.earlyDouble || 0,
          earlySingle: judgements.earlySingle || 0,
          ePerfect: judgements.ePerfect || 0,
          perfect: judgements.perfect || 0,
          lPerfect: judgements.lPerfect || 0,
          lateSingle: judgements.lateSingle || 0,
          lateDouble: judgements.lateDouble || 0,
        };

        const speed = submission.speed || 1;
        const accuracy = calcAcc(judgementData as IPassSubmissionJudgements);
        const scoreV2 = getScoreV2(
          {
            speed,
            judgements: judgementData as IPassSubmissionJudgements,
            isNoHoldTap: flags.isNoHoldTap || false,
          },
          {
            baseScore: level.baseScore,
            ppBaseScore: level.ppBaseScore,
            difficulty,
          },
        );

        // Validate calculated values
        if (!isValidNumber(accuracy)) {
          throw new Error(`Invalid accuracy calculated: ${accuracy}`);
        }
        if (!isValidNumber(scoreV2)) {
          throw new Error(`Invalid scoreV2 calculated: ${scoreV2} (baseScore: ${level.baseScore})`);
        }

        // === CREATE PHASE ===
        const passData = {
          levelId: submission.levelId,
          playerId,
          speed,
          vidTitle: submission.title || '',
          videoLink: submission.videoLink,
          vidUploadTime: submission.rawTime || new Date(),
          is12K: flags.is12K || false,
          is16K: flags.is16K || false,
          isNoHoldTap: flags.isNoHoldTap || false,
          feelingRating: submission.feelingDifficulty || null,
          accuracy,
          scoreV2,
          isAnnounced: false,
          isDeleted: false,
        };

        const pass = await Pass.create(passData, { transaction });

        // Create judgements record
        const now = new Date();
        const judgementRecord = await Judgement.create(
          {
            id: pass.id,
            ...judgementData,
            createdAt: now,
            updatedAt: now,
          },
          { transaction },
        );

        if (!judgementRecord) {
          throw new Error(`Failed to create judgement record for pass #${pass.id}`);
        }

        // Update submission status
        await submission.update(
          {
            status: 'approved',
            passId: pass.id,
          },
          { transaction },
        );

        // Update worlds first status
        await updateWorldsFirstStatus(submission.levelId, transaction);

        // Get complete pass with associations
        const newPass = await Pass.findByPk(pass.id, {
          include: [
            { model: Player, as: 'player' },
            {
              model: Level,
              as: 'level',
              include: [
                { model: Difficulty, as: 'difficulty' },
                { model: LevelCredit, as: 'levelCredits', include: [{ model: Creator, as: 'creator' }] },
              ],
            },
            { model: Judgement, as: 'judgements' },
          ],
          transaction,
        });

        if (!newPass) {
          throw new Error(`Failed to fetch created pass #${pass.id}`);
        }

        // Update player stats (in separate try-catch to not fail the main flow)
        let playerStats = null;
        try {
          await playerStatsService.updatePlayerStats([playerId]);
          playerStats = (await playerStatsService.getPlayerStats(playerId))?.[0];
        } catch (statsError) {
          const statsErrorDetails = extractErrorDetails(statsError);
          logger.warn('Failed to update player stats during auto-approve', {
            submissionId: submission.id,
            playerId,
            error: statsErrorDetails.message,
          });
        }

        await transaction.commit();

        // Index in Elasticsearch after commit
        await elasticsearchService.indexPass(newPass);
        await elasticsearchService.indexLevel(newPass.level!);

        // Broadcast updates
        if (playerStats) {
          sseManager.broadcast({
            type: 'passUpdate',
            data: {
              playerId,
              passedLevelId: submission.levelId,
              newScore: playerStats?.rankedScore || 0,
              action: 'create',
            },
          });
        }

        results.push({ id: submission.id, success: true });
      } catch (error) {
        await safeTransactionRollback(transaction, logger);
        const errorDetails = extractErrorDetails(error);
        logger.error('Error auto-approving submission', {
          submissionId: submission.id,
          levelId: submission.levelId,
          playerId: submission.assignedPlayerId,
          errorMessage: errorDetails.message,
          sqlQuery: errorDetails.sql,
          originalError: errorDetails.original,
          validationErrors,
        });
        results.push({
          id: submission.id,
          success: false,
          error: errorDetails.message,
          validationErrors: validationErrors.length > 0 ? validationErrors : undefined,
        });
      }
    }

    // Broadcast final updates
    sseManager.broadcast({ type: 'submissionUpdate' });
    sseManager.broadcast({
      type: 'submissionUpdate',
      data: {
        action: 'auto-approve',
        submissionType: 'pass',
        count: results.filter(r => r.success).length,
      },
    });

    const io = getIO();
    io.emit('leaderboardUpdated');

    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;

    return res.json({
      message: `Auto-approved ${successCount} submissions${failCount > 0 ? `, ${failCount} failed` : ''}`,
      results,
    });
  } catch (error) {
    const errorDetails = extractErrorDetails(error);
    logger.error('Error in auto-approve process:', {
      errorMessage: errorDetails.message,
      sqlQuery: errorDetails.sql,
      originalError: errorDetails.original,
    });
    return res.status(500).json({
      error: 'Failed to auto-approve submissions',
      details: errorDetails.message,
    });
  }
});


// Add endpoint to update profiles
router.put('/levels/:id/profiles', async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();

  try {
    const { id } = req.params;
    const { creatorRequests, teamRequestData } = req.body;

    // Simple updates without complex logic
    if (creatorRequests) {
      await Promise.all(creatorRequests.map(async (request: any) => {
        if (!request.id) return;

        await LevelSubmissionCreatorRequest.update({
          creatorId: request.creatorId,
          creatorName: request.creatorName,
          role: request.role,
          isNewRequest: false
        }, {
          where: {
            id: request.id,
            submissionId: id
          },
          transaction
        });
      }));
    }

    if (teamRequestData) {
      await LevelSubmissionTeamRequest.update({
        teamId: teamRequestData.teamId,
        teamName: teamRequestData.teamName,
        isNewRequest: false
      }, {
        where: { submissionId: id },
        transaction
      });
    }

    await transaction.commit();

    // Fetch fresh complete object with all associations AFTER committing the transaction
    const updatedSubmission = await LevelSubmission.findOne({
      where: { id },
      include: [
        {
          model: LevelSubmissionCreatorRequest,
          as: 'creatorRequests',
          include: [{
            model: Creator,
            as: 'creator',
            include: [
              {
                model: User,
                as: 'user',
                attributes: ['id', 'username']
              },
              {
                model: LevelCredit,
                as: 'credits',
                attributes: ['id', 'role']
              }
            ]
          }]
        },
        {
          model: LevelSubmissionTeamRequest,
          as: 'teamRequestData',
          include: [{
            model: Team,
            as: 'team',
            include: [
              {
                model: Creator,
                as: 'teamCreators',
                through: { attributes: [] },
                required: false
              }
            ]
          }]
        }
      ]
    });

    if (!updatedSubmission) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    // Process the submission data to match the format used in pending submissions
    const submissionData = updatedSubmission.toJSON();

    // Process creator requests
    submissionData.creatorRequests = submissionData.creatorRequests?.map((request: any) => {
      if (request.creator?.credits) {
        const credits = request.creator.credits;
        const creditStats = {
          charterCount: credits.filter((credit: any) => credit.role === 'charter').length,
          vfxerCount: credits.filter((credit: any) => credit.role === 'vfxer').length,
          totalCredits: credits.length
        };
        request.creator.credits = creditStats;
      }
      return request;
    });

    // Process team request data
    if (submissionData.teamRequestData?.team) {
      const team = submissionData.teamRequestData.team;
      team.credits = {
        totalLevels: team.levels?.length || 0,
        verifiedLevels: team.levels?.filter((l: any) => l.isVerified).length || 0,
        memberCount: team.members?.length || 0
      };
      // Clean up levels array to avoid sending too much data
      delete team.levels;
    }

    return res.json(submissionData);

  } catch (error) {
    await safeTransactionRollback(transaction, logger);
    logger.error('Error updating submission profiles:', error);
    return res.status(500).json({ error: 'Failed to update submission profiles' });
  }
});

// Assign creator to submission
router.put('/levels/:id/assign-creator', Auth.superAdmin(), async (req: Request, res: Response) => {
    const transaction = await sequelize.transaction();

    try {
      const { id } = req.params;
      const { creatorId, role, creditRequestId } = req.body;

      if (!creatorId || !role || !creditRequestId) {
        await safeTransactionRollback(transaction, logger);
        return res.status(400).json({ error: 'Creator ID, role, and credit request ID are required' });
      }

      // Verify submission exists
      const submission = await LevelSubmission.findOne({
        where: { id },
        include: [
          {
            model: LevelSubmissionCreatorRequest,
            as: 'creatorRequests'
          }
        ],
        transaction
      });

      if (!submission) {
        await safeTransactionRollback(transaction, logger);
        return res.status(404).json({ error: 'Submission not found' });
      }

      // Verify creator exists and get their name
      const creator = await Creator.findByPk(creatorId, { transaction });
      if (!creator) {
        await safeTransactionRollback(transaction, logger);
        return res.status(404).json({ error: 'Creator not found' });
      }

      // Find and update the specific creator request
      const creatorRequest = await LevelSubmissionCreatorRequest.findOne({
        where: {
          id: creditRequestId,
          submissionId: parseInt(id),
          role
        },
        transaction
      });

      if (!creatorRequest) {
        await safeTransactionRollback(transaction, logger);
        return res.status(404).json({ error: 'Credit request not found' });
      }

      // Update the request
      await creatorRequest.update({
        creatorId,
        creatorName: creator.name,
        isNewRequest: false
      }, { transaction });

      await transaction.commit();

      return res.json({
        message: 'Creator assigned successfully',
        creatorRequest
      });
    } catch (error) {
      await safeTransactionRollback(transaction, logger);
      logger.error('Error assigning creator:', error);
      return res.status(500).json({ error: 'Failed to assign creator' });
    }
  }
);

// Add endpoint to create and assign creator in one step
router.post('/levels/:id/creators', async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();

  try {
    const { id } = req.params;
    const { name, aliases, role, creditRequestId } = req.body;

    if (!name || !role || !creditRequestId) {
      await safeTransactionRollback(transaction, logger);
      return res.status(400).json({ error: 'Name, role, and credit request ID are required' });
    }

    // Find the submission with both creator and team requests
    const submission = await LevelSubmission.findOne({
      where: { id },
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

    if (!submission) {
      await safeTransactionRollback(transaction, logger);
      return res.status(404).json({ error: 'Submission not found' });
    }

    if (role === 'team') {
      // Create or find team without checking isNewRequest
      const [team] = await Team.findOrCreate({
        where: { name: name.trim() },
        transaction
      });

      // Create team aliases if provided
      if (aliases && Array.isArray(aliases) && aliases.length > 0) {
        const aliasRecords = aliases.map((alias: string) => ({
          teamId: team.id,
          name: alias.trim(),
        }));

        await TeamAlias.bulkCreate(aliasRecords, {
          transaction,
          ignoreDuplicates: true
        });
      }

      // Update team request
      await LevelSubmissionTeamRequest.update({
        teamId: team.id,
        teamName: team.name,
        isNewRequest: false
      }, {
        where: { submissionId: parseInt(id) },
        transaction
      });
    } else {
      // Create or find creator without checking isNewRequest
      const [creator] = await Creator.findOrCreate({
        where: { name: name.trim() },
        defaults: {
          isVerified: false
        },
        transaction
      });

      // Update the existing credit request
      await LevelSubmissionCreatorRequest.update({
        creatorId: creator.id,
        creatorName: creator.name,
        isNewRequest: false
      }, {
        where: {
          id: creditRequestId,
          submissionId: parseInt(id)
        },
        transaction
      });
    }

    await transaction.commit();

    // Fetch fresh complete object with all associations AFTER committing the transaction
    const updatedSubmission = await LevelSubmission.findOne({
      where: { id },
      include: [
        {
          model: LevelSubmissionCreatorRequest,
          as: 'creatorRequests',
          include: [{
            model: Creator,
            as: 'creator',
            include: [
              {
                model: User,
                as: 'user',
                attributes: ['id', 'username']
              },
              {
                model: LevelCredit,
                as: 'credits',
                attributes: ['id', 'role']
              }
            ]
          }]
        },
        {
          model: LevelSubmissionTeamRequest,
          as: 'teamRequestData',
          include: [{
            model: Team,
            as: 'team',
            include: [
              {
                model: Creator,
                as: 'teamCreators',
                through: { attributes: [] },
                required: false
              }
            ]
          }]
        }
      ]
    });

    if (!updatedSubmission) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    // Process the submission data to match the format used in pending submissions
    const submissionData = updatedSubmission.toJSON();

    // Process creator requests
    submissionData.creatorRequests = submissionData.creatorRequests?.map((request: any) => {
      if (request.creator?.credits) {
        const credits = request.creator.credits;
        const creditStats = {
          charterCount: credits.filter((credit: any) => credit.role === 'charter').length,
          vfxerCount: credits.filter((credit: any) => credit.role === 'vfxer').length,
          totalCredits: credits.length
        };
        request.creator.credits = creditStats;
      }
      return request;
    });

    // Process team request data
    if (submissionData.teamRequestData?.team) {
      const team = submissionData.teamRequestData.team;
      team.credits = {
        totalLevels: team.levels?.length || 0,
        verifiedLevels: team.levels?.filter((l: any) => l.isVerified).length || 0,
        memberCount: team.members?.length || 0
      };
      // Clean up levels array to avoid sending too much data
      delete team.levels;
    }

    return res.json(submissionData);

  } catch (error) {
    await safeTransactionRollback(transaction, logger);
    logger.error('Error creating and assigning creator:', error);
    return res.status(500).json({ error: 'Failed to create and assign creator' });
  }
});

// Add a new creator request
router.post('/levels/:id/creator-requests', async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();

  try {
    const { id } = req.params;
    const { role } = req.body;

    if (!role) {
      await safeTransactionRollback(transaction, logger);
      return res.status(400).json({ error: 'Role is required' });
    }

    // Find the submission
    const submission = await LevelSubmission.findOne({
      where: { id },
      include: [
        {
          model: LevelSubmissionCreatorRequest,
          as: 'creatorRequests'
        }
      ],
      transaction
    });

    if (!submission) {
      await safeTransactionRollback(transaction, logger);
      return res.status(404).json({ error: 'Submission not found' });
    }

    // Create a new creator request with a placeholder name
    const placeholderName = `New ${role.charAt(0).toUpperCase() + role.slice(1)}`;

    if (role === 'team') {
      await LevelSubmissionTeamRequest.create({
      submissionId: parseInt(id),
      teamName: placeholderName,
      isNewRequest: true
    }, { transaction })
    } else {
      await LevelSubmissionCreatorRequest.create({
      submissionId: parseInt(id),
      role,
      creatorName: placeholderName,
      isNewRequest: true
    }, { transaction });
    }

    await transaction.commit();

    // Fetch updated submission
    const updatedSubmission = await LevelSubmission.findOne({
      where: { id },
      include: [
        {
          model: LevelSubmissionCreatorRequest,
          as: 'creatorRequests',
          include: [{
            model: Creator,
            as: 'creator',
            include: [
              {
                model: User,
                as: 'user',
                attributes: ['id', 'username']
              },
              {
                model: LevelCredit,
                as: 'credits',
                attributes: ['id', 'role']
              }
            ]
          }]
        },
        {
          model: LevelSubmissionTeamRequest,
          as: 'teamRequestData',
          include: [{
            model: Team,
            as: 'team',
            include: [
              {
                model: Creator,
                as: 'teamCreators',
                through: { attributes: [] },
                required: false
              }
            ]
          }]
        }
      ]
    });

    return res.json(updatedSubmission);
  } catch (error) {
    await safeTransactionRollback(transaction, logger);
    logger.error('Error adding creator request:', error);
    return res.status(500).json({ error: 'Failed to add creator request' });
  }
});

// Remove a creator request
router.delete('/levels/:id/creator-requests/:requestId', async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();

  try {
    const { id, requestId } = req.params;

    // Find the submission
    const submission = await LevelSubmission.findOne({
      where: { id },
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

    if (!submission || !submission.creatorRequests) {
      await safeTransactionRollback(transaction, logger);
      return res.status(404).json({ error: 'Submission not found' });
    }

    // First check if this is a team request
    const teamRequest = await LevelSubmissionTeamRequest.findOne({
      where: { id: parseInt(requestId), submissionId: id },
      transaction
    });

    if (teamRequest) {
      // Handle team request deletion
      await LevelSubmissionTeamRequest.destroy({
        where: {
          id: requestId,
          submissionId: id
        },
        transaction
      });
    } else {
      // Handle creator request deletion
      const request = submission.creatorRequests.find(r => r.id === parseInt(requestId));
      const isCharter = request?.role === CreditRole.CHARTER;

      if (isCharter) {
        const charterCount = submission.creatorRequests.filter(r => r.role === CreditRole.CHARTER).length;
        if (charterCount <= 1) {
          await safeTransactionRollback(transaction, logger);
          return res.status(400).json({ error: 'Cannot remove the last charter' });
        }
      }

      // Delete the creator request
      await LevelSubmissionCreatorRequest.destroy({
        where: {
          id: requestId,
          submissionId: id
        },
        transaction
      });
    }

    await transaction.commit();

    // Return the updated submission
    const updatedSubmission = await LevelSubmission.findOne({
      where: { id },
      include: [
        {
          model: LevelSubmissionCreatorRequest,
          as: 'creatorRequests'
        },
        {
          model: LevelSubmissionTeamRequest,
          as: 'teamRequestData'
        }
      ]
    });

    return res.json(updatedSubmission);
  } catch (error) {
    await safeTransactionRollback(transaction, logger);
    logger.error('Error removing creator request:', error);
    return res.status(500).json({ error: 'Failed to remove creator request' });
  }
});

// Mount song/artist management routes
router.use('/', submissionSongArtistRoutes);

export default router;
