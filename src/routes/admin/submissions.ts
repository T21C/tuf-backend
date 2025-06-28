import {Request, Response, Router} from 'express';
import {Auth} from '../../middleware/auth.js';
import {
  PassSubmission,
  PassSubmissionFlags,
  PassSubmissionJudgements,
} from '../../models/submissions/PassSubmission.js';
import Pass from '../../models/passes/Pass.js';
import Level from '../../models/levels/Level.js';
import Difficulty from '../../models/levels/Difficulty.js';
import Judgement from '../../models/passes/Judgement.js';
import {calcAcc} from '../../utils/CalcAcc.js';
import {getScoreV2} from '../../utils/CalcScore.js';
import {getIO} from '../../utils/socket.js';
import sequelize from '../../config/db.js';
import {sseManager} from '../../utils/sse.js';
import {PlayerStatsService} from '../../services/PlayerStatsService.js';
import {updateWorldsFirstStatus} from '../database/passes/index.js';
import {IPassSubmissionJudgements} from '../../interfaces/models/index.js';
import LevelSubmission from '../../models/submissions/LevelSubmission.js';
import Rating from '../../models/levels/Rating.js';
import Player from '../../models/players/Player.js';
import Team from '../../models/credits/Team.js';
import LevelSubmissionCreatorRequest from '../../models/submissions/LevelSubmissionCreatorRequest.js';
import LevelSubmissionTeamRequest from '../../models/submissions/LevelSubmissionTeamRequest.js';
import Creator from '../../models/credits/Creator.js';
import LevelCredit from '../../models/levels/LevelCredit.js';
import User from '../../models/auth/User.js';
import { Op } from 'sequelize';
import { logger } from '../../services/LoggerService.js';
import ElasticsearchService from '../../services/ElasticsearchService.js';
import { CDN_CONFIG } from '../../cdnService/config.js';
import cdnService from '../../services/CdnService.js';
import { safeTransactionRollback } from '../../utils/Utility.js';

const router: Router = Router();
const playerStatsService = PlayerStatsService.getInstance();
const elasticsearchService = ElasticsearchService.getInstance();

enum CreditRole {
  CHARTER = 'charter',
  VFXER = 'vfxer',
  TEAM = 'team'
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
                  model: Creator,
                  as: 'members',
                  through: { attributes: [] },
                  required: false
                }
              ]
            }
          ]
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
            }
          ],
          transaction,
        });

        if (!submissionObj) {
          await safeTransactionRollback(transaction, logger);
          return res.status(404).json({error: 'Submission not found'});
        }

        // Check if all creator requests are either assigned or marked as new
        const hasUnhandledCreators = submissionObj.creatorRequests?.some(
          (request) => !request.creatorId && !request.isNewRequest
        );

        if (hasUnhandledCreators) {
          await safeTransactionRollback(transaction, logger);
          return res.status(400).json({
            error: 'All creators must be either assigned to existing creators or marked as new creators'
          });
        }

        // Check if team request is properly handled
        if (submissionObj.teamRequestData && !submissionObj.teamRequestData.teamId && !submissionObj.teamRequestData.isNewRequest) {
          await safeTransactionRollback(transaction, logger);
          return res.status(400).json({
            error: 'Team must be either assigned to an existing team or marked as a new team'
          });
        }

        const submission = submissionObj.dataValues;
        
        // Get the next available ID in a transaction-safe way
        const lastLevel = await Level.findOne({
          order: [['id', 'DESC']],
          transaction,
          lock: true // Lock the row to prevent race conditions
        });
        
        // Start from 1 if no levels exist, otherwise increment the last ID
        let nextId = 1;
        if (lastLevel) {
          nextId = lastLevel.id + 1;
          
          // Double check this ID isn't taken (in case of gaps)
          const existingLevel = await Level.findByPk(nextId, { transaction });
          while (existingLevel) {
            nextId++;
            const checkLevel = await Level.findByPk(nextId, { transaction });
            if (!checkLevel) break;
          }
        }

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

        const newLevel = await Level.create(
          {
            id: nextId,
            song: submission.song,
            artist: submission.artist,
            creator: firstCharter?.creatorName || '',
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
            isCleared: false,
            isVerified: hasSimpleCredits && allExistingCreatorsVerified && 
                       !submission.creatorRequests?.some((r: LevelSubmissionCreatorRequest) => r.isNewRequest) &&
                       (!submission.teamRequestData || !submission.teamRequestData.isNewRequest),
            clears: 0,
            likes: 0,
            publicComments: '',
            submitterDiscordId: submission.submitterDiscordId,
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
                isVerified: existingCreators.find((c: Creator) => c.id === request.creatorId)?.isVerified || false
              }, {
                transaction
              });
            }
          } else if (request.isNewRequest) {
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

        await transaction.commit();

        // Index the level in Elasticsearch after transaction is committed
        await elasticsearchService.indexLevel(newLevel);

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

        return res.json({
          message: 'Submission approved, level and rating created successfully',
        });
    } catch (error) {
      await safeTransactionRollback(transaction, logger);
      logger.error('Error processing level submission:', error);
      return res
        .status(500)
        .json({error: 'Failed to process level submission'});
    }
  },
);


router.put('/levels/:id/decline', Auth.superAdmin(), async (req: Request, res: Response) => {
    const transaction = await sequelize.transaction();

    try {
      const {id} = req.params;

      // Get the submission to check if it has a level zip
      const submission = await LevelSubmission.findByPk(id);
      if (!submission) {
        await safeTransactionRollback(transaction, logger);
        return res.status(404).json({error: 'Submission not found'});
      }

      // Check if the directDL is a local CDN URL
      if (submission.directDL && submission.directDL.startsWith(`${CDN_CONFIG.baseUrl}/cdn/levels/`)) {
        const fileId = submission.directDL.split('/').pop();
        if (fileId) {
          await cdnService.deleteFile(fileId);
        }
      }

      await LevelSubmission.update(
        {status: 'declined'},
        {
          where: {id},
          transaction,
        },
      );

      await transaction.commit();

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

      return res.json({message: 'Submission declined successfully'});
    } catch (error) {
      await safeTransactionRollback(transaction, logger);
      logger.error('Error processing level submission:', error);
      return res
        .status(500)
        .json({error: 'Failed to process level submission'});
    }
  },
);


// Split pass submission actions into specific endpoints
router.put('/passes/:id/approve', Auth.superAdmin(), async (req: Request, res: Response) => {
    const transaction = await sequelize.transaction();
    try {
      const {id} = req.params;
      const submission = await PassSubmission.findOne({
        where: {[Op.and]: [{id: parseInt(id)}, {status: 'pending'}]},
        include: [
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

      if (!submission) {
        await safeTransactionRollback(transaction, logger);
        return res.status(404).json({error: 'Submission not found'});
      }

      // Validate level and difficulty data
      if (!submission.level) {
        await safeTransactionRollback(transaction, logger);
        return res.status(404).json({error: 'Level data not found'});
      }

      if (!submission.level.difficulty) {
        await safeTransactionRollback(transaction, logger);
        return res.status(404).json({error: 'Difficulty data not found'});
      }

      // Create properly structured level data for score calculation
      const levelData = {
        baseScore: submission.level.baseScore,
        difficulty: submission.level.difficulty,
      };

      // Create pass
      const pass = await Pass.create(
        {
          levelId: submission.levelId,
          playerId: submission.assignedPlayerId || 0,
          speed: submission.speed || 1,
          vidTitle: submission.title,
          videoLink: submission.videoLink,
          vidUploadTime: submission.rawTime || new Date(),
          is12K: submission.flags?.is12K || false,
          is16K: submission.flags?.is16K || false,
          isNoHoldTap: submission.flags?.isNoHoldTap || false,
          feelingRating: submission.feelingDifficulty || null,
          accuracy: calcAcc(
            submission.judgements ||
              ({
                earlyDouble: 0,
                earlySingle: 0,
                ePerfect: 5,
                perfect: 40,
                lPerfect: 5,
                lateSingle: 0,
                lateDouble: 0,
              } as IPassSubmissionJudgements),
          ),
          scoreV2: getScoreV2(
            {
              speed: submission.speed || 1,
              judgements:
                ({
                  earlyDouble: submission.judgements?.earlyDouble || 0,
                  earlySingle: submission.judgements?.earlySingle || 0,
                  ePerfect: submission.judgements?.ePerfect || 0,
                  perfect: submission.judgements?.perfect || 0,
                  lPerfect: submission.judgements?.lPerfect || 0,
                  lateSingle: submission.judgements?.lateSingle || 0,
                  lateDouble: submission.judgements?.lateDouble || 0,
                } as IPassSubmissionJudgements),
              isNoHoldTap: submission.flags?.isNoHoldTap || false,
            },
            levelData,
          ),
          isAnnounced: false,
          isDeleted: false,
        },
        {transaction},
      );

      if (!submission.judgements) {
        throw new Error(`Judgements for pass #${pass.id} not found`);
      }
      // Create judgements
        const now = new Date();
        const judgements = await Judgement.create(
          {
            id: pass.id,
            earlyDouble: submission.judgements.earlyDouble || 0,
            earlySingle: submission.judgements.earlySingle || 0,
            ePerfect: submission.judgements.ePerfect || 0,
            perfect: submission.judgements.perfect || 0,
            lPerfect: submission.judgements.lPerfect || 0,
            lateSingle: submission.judgements.lateSingle || 0,
            lateDouble: submission.judgements.lateDouble || 0,
            createdAt: now,
            updatedAt: now,
          },
          {transaction},
        )
        if (!judgements) {
          throw new Error(`Judgement for pass #${pass.id} not created`);
        }

      // Update submission status
      await submission.update(
        {
          status: 'approved',
          passId: pass.id,
        },
        {transaction},
      );
      // Update worlds first status if needed
      await updateWorldsFirstStatus(submission.levelId, transaction);

        // Commit the transaction for this submission
        
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
              ],
            },
            {
              model: Judgement,
              as: 'judgements',
            },
          ],
          transaction,
        });
      await transaction.commit();
      // Index the pass in Elasticsearch after transaction is committed
      await elasticsearchService.indexPass(newPass!);
      await elasticsearchService.indexLevel(newPass!.level!);

      // Update player stats - these operations don't need to be part of the transaction
      if (submission.assignedPlayerId) {
        try {
          // Create a new transaction for player stats update
          const statsTransaction = await sequelize.transaction();
          try {
            await playerStatsService.updatePlayerStats(
              [submission.assignedPlayerId],
            );
            
            // Commit the stats transaction
            await statsTransaction.commit();

            // Get player's new stats
            const playerStats = await playerStatsService.getPlayerStats(
              submission.assignedPlayerId,
            ).then(stats => stats?.[0]);

            sseManager.broadcast({
              type: 'submissionUpdate',
              data: {
                action: 'create',
                submissionId: submission.id,
                submissionType: 'pass',
              },
            });
            // Emit SSE event with pass update data
            sseManager.broadcast({
              type: 'passUpdate',
              data: {
                playerId: submission.assignedPlayerId,
                passedLevelId: submission.levelId,
                newScore: playerStats?.rankedScore || 0,
                action: 'create',
              },
            });
          } catch (error) {
            // If there's an error, rollback the stats transaction
            await statsTransaction.rollback();
            throw error;
          }
        } catch (error) {
          logger.error('Error updating player stats:', error);
          // Don't rollback main transaction here since it's already committed
        }
      }

      sseManager.broadcast({
        type: 'submissionUpdate',
        data: {
          action: 'create',
          submissionId: submission.id,
          submissionType: 'pass',
        },
      });

      return res.json({
        message: 'Pass submission approved successfully',
        pass,
      });
    } catch (error) {
      // Only rollback if the transaction hasn't been committed yet
      try {
        await transaction.rollback();
      } catch (rollbackError) {
        // Ignore rollback errors - transaction might already be committed
        logger.error('Error rolling back transaction:', rollbackError);
      }
      logger.error('Error processing pass submission:', error);
      return res.status(500).json({error: 'Failed to process pass submission'});
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

      await transaction.commit();

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

      return res.json({message: 'Pass submission rejected successfully'});
    } catch (error) {
      await safeTransactionRollback(transaction, logger);
      logger.error('Error declining pass submission:', error);
      return res.status(500).json({error: 'Failed to decline pass submission'});
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

      await transaction.commit();

      // Broadcast the update
      sseManager.broadcast({
        type: 'submissionUpdate',
        data: {
          action: 'assign-player',
          submissionId: req.params.id,
          submissionType: 'pass',
        },
      });

      return res.json({
        message: 'Player assigned successfully',
        submission,
      });
    } catch (error) {
      await safeTransactionRollback(transaction, logger);
      logger.error('Error assigning player:', error);
      return res.status(500).json({error: 'Failed to assign player'});
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
          include: [{ model: Difficulty, as: 'difficulty' }],
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

    const results = [];

    for (const submission of pendingSubmissions) {
      // Create a new transaction for each submission
      const transaction = await sequelize.transaction();
      
      try {
        // Validate required data
        if (!submission.flags || !submission.judgements || !submission.level || !submission.level.difficulty) {
          throw new Error('Missing required submission data');
        }

        // Create pass with all required fields
        const pass = await Pass.create({
          levelId: submission.levelId,
          playerId: submission.assignedPlayerId!,
          speed: submission.speed || 1,
          vidTitle: submission.title,
          videoLink: submission.videoLink,
          vidUploadTime: submission.rawTime || new Date(),
          is12K: submission.flags.is12K || false,
          is16K: submission.flags.is16K || false,
          isNoHoldTap: submission.flags.isNoHoldTap || false,
          feelingRating: submission.feelingDifficulty || null,
          accuracy: calcAcc(submission.judgements),
          scoreV2: getScoreV2(
            {
              speed: submission.speed || 1,
              judgements: submission.judgements,
              isNoHoldTap: submission.flags.isNoHoldTap || false
            },
            {
              baseScore: submission.level.baseScore,
              difficulty: submission.level.difficulty
            }
          ),
          isAnnounced: false,
          isDeleted: false
        }, { transaction });

        if (!pass) {
          throw new Error(`Pass for submission #${submission.id} not created`);
        }

        // Create judgements with proper error handling
        const judgements = await Judgement.create({
          id: pass.id,
          earlyDouble: submission.judgements.earlyDouble || 0,
          earlySingle: submission.judgements.earlySingle || 0,
          ePerfect: submission.judgements.ePerfect || 0,
          perfect: submission.judgements.perfect || 0,
          lPerfect: submission.judgements.lPerfect || 0,
          lateSingle: submission.judgements.lateSingle || 0,
          lateDouble: submission.judgements.lateDouble || 0,
          createdAt: new Date(),
          updatedAt: new Date()
        }, { transaction });

        if (!judgements) {
          throw new Error(`Judgements for pass #${pass.id} not created`);
        }

        // Update submission status
        await submission.update({
          status: 'approved',
          passId: pass.id
        }, { transaction });

        // Update worlds first status
        await updateWorldsFirstStatus(submission.levelId, transaction);

        // Get the complete pass object with all associations
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
              ],
            },
            {
              model: Judgement,
              as: 'judgements',
            },
          ],
          transaction,
        });

        if (!newPass) {
          throw new Error(`Failed to fetch created pass #${pass.id}`);
        }

        // Commit the transaction
        await transaction.commit();

        // Index in Elasticsearch after transaction is committed
        await elasticsearchService.indexPass(newPass);
        await elasticsearchService.indexLevel(newPass.level!);

        // Update player stats in a separate transaction
        if (submission.assignedPlayerId) {
          try {
            const statsTransaction = await sequelize.transaction();
            try {
              await playerStatsService.updatePlayerStats([submission.assignedPlayerId]);
              await statsTransaction.commit();

              // Get updated player stats
              const playerStats = 
              await playerStatsService.getPlayerStats(submission.assignedPlayerId)
              .then(stats => stats?.[0]);

              // Broadcast updates
              sseManager.broadcast({
                type: 'passUpdate',
                data: {
                  playerId: submission.assignedPlayerId,
                  passedLevelId: submission.levelId,
                  newScore: playerStats?.rankedScore || 0,
                  action: 'create'
                }
              });
            } catch (error) {
              await statsTransaction.rollback();
              throw error;
            }
          } catch (error) {
            logger.error('Error updating player stats:', error);
            // Don't rollback main transaction since it's already committed
          }
        }

        results.push({ id: submission.id, success: true });
      } catch (error) {
        // Rollback the transaction for this submission
        await safeTransactionRollback(transaction, logger);
        logger.error(`Error auto-approving submission ${submission.id}:`, error);
        results.push({ 
          id: submission.id, 
          success: false, 
          error: error instanceof Error ? error.message : String(error) 
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
        count: results.filter(r => r.success).length
      }
    });

    const io = getIO();
    io.emit('leaderboardUpdated');

    return res.json({
      message: `Auto-approved ${results.filter(r => r.success).length} submissions`,
      results
    });

  } catch (error) {
    logger.error('Error in auto-approve process:', error);
    return res.status(500).json({
      error: 'Failed to auto-approve submissions',
      details: error instanceof Error ? error.message : String(error)
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
                model: Level,
                as: 'createdLevels',
                attributes: ['id', 'isVerified']
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
                as: 'members',
                through: { attributes: [] },
                required: false
              },
              {
                model: Level,
                as: 'levels',
                attributes: ['id', 'isVerified'],
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
                model: Level,
                as: 'createdLevels',
                attributes: ['id', 'isVerified']
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
                as: 'members',
                through: { attributes: [] },
                required: false
              },
              {
                model: Level,
                as: 'levels',
                attributes: ['id', 'isVerified'],
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
    const newRequest = 
    role === 'team' 

    ? await LevelSubmissionTeamRequest.create({
      submissionId: parseInt(id),
      teamName: placeholderName,
      isNewRequest: true
    }, { transaction }) 
    
    : await LevelSubmissionCreatorRequest.create({
      submissionId: parseInt(id),
      role,
      creatorName: placeholderName,
      isNewRequest: true
    }, { transaction });

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
                model: Level,
                as: 'createdLevels',
                attributes: ['id', 'isVerified']
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
                as: 'members',
                through: { attributes: [] },
                required: false
              },
              {
                model: Level,
                as: 'levels',
                attributes: ['id', 'isVerified'],
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
      await transaction.rollback();
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
          await transaction.rollback();
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
    await transaction.rollback();
    logger.error('Error removing creator request:', error);
    return res.status(500).json({ error: 'Failed to remove creator request' });
  }
});

export default router;
