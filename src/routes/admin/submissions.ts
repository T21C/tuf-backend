import {Request, Response, Router} from 'express';
import {Auth} from '../../middleware/auth.js';
import {
  PassSubmission,
  PassSubmissionFlags,
  PassSubmissionJudgements,
} from '../../models/PassSubmission.js';
import Pass from '../../models/Pass.js';
import Level from '../../models/Level.js';
import Difficulty from '../../models/Difficulty.js';
import Judgement from '../../models/Judgement.js';
import {calcAcc} from '../../misc/CalcAcc.js';
import {getScoreV2} from '../../misc/CalcScore.js';
import {getIO} from '../../utils/socket.js';
import sequelize from '../../config/db.js';
import {sseManager} from '../../utils/sse.js';
import {excludePlaceholder} from '../../middleware/excludePlaceholder.js';
import {PlayerStatsService} from '../../services/PlayerStatsService.js';
import {updateWorldsFirstStatus} from '../database/passes.js';
import {IPassSubmissionJudgements} from '../../interfaces/models/index.js';
import LevelSubmission from '../../models/LevelSubmission.js';
import Rating from '../../models/Rating.js';
import Player from '../../models/Player.js';
import {migrateNewCredits} from '../../utils/migrateCredits.js';
import Team from '../../models/Team.js';
import LevelSubmissionCreatorRequest from '../../models/LevelSubmissionCreatorRequest.js';
import LevelSubmissionTeamRequest from '../../models/LevelSubmissionTeamRequest.js';
import Creator from '../../models/Creator.js';
import LevelCredit from '../../models/LevelCredit.js';
import User from '../../models/User.js';
import TeamMember from '../../models/TeamMember.js';

const router: Router = Router();
const playerStatsService = PlayerStatsService.getInstance();

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
router.get(
  '/levels',
  excludePlaceholder.fromResponse(),
  async (req: Request, res: Response) => {
    try {
      const levelSubmissions = await LevelSubmission.findAll();
      return res.json(levelSubmissions);
    } catch (error) {
      console.error('Error fetching level submissions:', error);
      return res.status(500).json({error: 'Failed to fetch level submissions'});
    }
  },
);

// Get pending level submissions
router.get('/levels/pending', async (req: Request, res: Response) => {
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
    console.error('Error fetching pending level submissions:', error);
    return res.status(500).json({ error: 'Failed to fetch pending level submissions' });
  }
});

// Get all pass submissions
router.get(
  '/passes',
  excludePlaceholder.fromResponse(),
  async (req: Request, res: Response) => {
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
      console.error('Error fetching pass submissions:', error);
      return res.status(500).json({error: 'Failed to fetch pass submissions'});
    }
  },
);

// Get pending pass submissions
router.get(
  '/passes/pending',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
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
        ],
        order: [['createdAt', 'DESC']],
      });
      return res.json(submissions);
    } catch (error) {
      console.error('Error fetching pending pass submissions:', error);
      return res
        .status(500)
        .json({error: 'Failed to fetch pending pass submissions'});
    }
  },
);

// Handle level submission actions (approve/reject)
router.put(
  '/levels/:id/approve',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    const transaction = await sequelize.transaction();

    try {
      const {id} = req.params;
        const submissionObj = await LevelSubmission.findOne({
          where: {id},
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
          await transaction.rollback();
          return res.status(404).json({error: 'Submission not found'});
        }

        // Check if all creator requests are either assigned or marked as new
        const hasUnhandledCreators = submissionObj.creatorRequests?.some(
          (request) => !request.creatorId && !request.isNewRequest
        );

        if (hasUnhandledCreators) {
          await transaction.rollback();
          return res.status(400).json({
            error: 'All creators must be either assigned to existing creators or marked as new creators'
          });
        }

        // Check if team request is properly handled
        if (submissionObj.teamRequestData && !submissionObj.teamRequestData.teamId && !submissionObj.teamRequestData.isNewRequest) {
          await transaction.rollback();
          return res.status(400).json({
            error: 'Team must be either assigned to an existing team or marked as a new team'
          });
        }

        const submission = submissionObj.dataValues;
        const lastLevel = await Level.findOne({
          order: [['id', 'DESC']],
          transaction,
        });
        const nextId = lastLevel ? lastLevel.id + 1 : 1;

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
              await transaction.rollback();
              return res.status(404).json({ error: 'Referenced team not found' });
            }
            teamId = team.id;
          } else if (submission.teamRequestData.isNewRequest) {
            // Create new team
            [team] = await Team.findOrCreate({
              where: { name: submission.teamRequestData.teamName.trim() },
              defaults: { aliases: [] },
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

        const allExistingCreatorsVerified = existingCreators.every(c => c.isVerified);

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
            publicComments: '',
            submitterDiscordId: submission.submitterDiscordId,
            rerateReason: '',
            rerateNum: '',
            previousDiffId: 0,
            isAnnounced: false,
            isHidden: false,
            teamId: teamId,
          },
          {transaction},
        );

        // Create rating since toRate is true
        await Rating.create(
          {
            levelId: newLevel.id,
            currentDifficultyId: 0,
            lowDiff: /^[pP]\d/.test(submission.diff),
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
                isVerified: existingCreators.find(c => c.id === request.creatorId)?.isVerified || false
              }, {
                transaction
              });
            }
          } else if (request.isNewRequest) {
            // For new creators
            const [creator] = await Creator.findOrCreate({
              where: { name: request.creatorName.trim() },
              defaults: {
                aliases: [],
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
      await transaction.rollback();
      console.error('Error processing level submission:', error);
      return res
        .status(500)
        .json({error: 'Failed to process level submission'});
    }
  },
);


router.put(
  '/levels/:id/decline',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    const transaction = await sequelize.transaction();

    try {
      const {id} = req.params;

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
      await transaction.rollback();
      console.error('Error processing level submission:', error);
      return res

        .status(500)
        .json({error: 'Failed to process level submission'});
    }
  },
);


// Split pass submission actions into specific endpoints
router.put(
  '/passes/:id/approve',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    const transaction = await sequelize.transaction();
    try {
      const submission = await PassSubmission.findOne({
        where: {id: parseInt(req.params.id)},
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
        await transaction.rollback();
        return res.status(404).json({error: 'Submission not found'});
      }

      // Validate level and difficulty data
      if (!submission.level) {
        await transaction.rollback();
        return res.status(404).json({error: 'Level data not found'});
      }

      if (!submission.level.difficulty) {
        await transaction.rollback();
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

      // Create judgements
      if (submission.judgements) {
        const now = new Date();
        await Judgement.create(
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
        );
      }

      // Update submission status
      await submission.update(
        {
          status: 'approved',
          passId: pass.id,
        },
        {transaction},
      );

      // Update level clear count
      await Level.increment('clears', {
        where: {id: submission.levelId},
        transaction,
      });

      // Update worlds first status if needed
      await updateWorldsFirstStatus(submission.levelId, transaction);

      await transaction.commit();

      // Update player stats
      if (submission.assignedPlayerId) {
        await playerStatsService.updatePlayerStats(
          submission.assignedPlayerId,
        );

        // Get player's new stats
        const playerStats = await playerStatsService.getPlayerStats(
          submission.assignedPlayerId,
        );

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
      }

      const io = getIO();
      io.emit('leaderboardUpdated');

      return res.json({
        message: 'Pass submission approved successfully',
        pass,
      });
    } catch (error) {
      await transaction.rollback();
      console.error('Error processing pass submission:', error);
      return res.status(500).json({error: 'Failed to process pass submission'});
    }
  }
);

router.put(
  '/passes/:id/decline',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
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
      await transaction.rollback();
      console.error('Error declining pass submission:', error);
      return res.status(500).json({error: 'Failed to decline pass submission'});
    }
  }
);

router.put(
  '/passes/:id/assign-player',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
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
        await transaction.rollback();
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
      await transaction.rollback();
      console.error('Error assigning player:', error);
      return res.status(500).json({error: 'Failed to assign player'});
    }
  }
);

// Auto-approve pass submissions
router.post(
  '/auto-approve/passes',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    const transaction = await sequelize.transaction();

    try {
      // Find all pending submissions
      const pendingSubmissions = await PassSubmission.findAll({
        where: {
          status: 'pending',
        },
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
            required: true,
          },
          {
            model: Player,
            as: 'assignedPlayer',
            required: false,
          },
        ],
        transaction,
      });

      const matchingSubmissions = await Promise.all(
        pendingSubmissions.map(async submission => {
          // Only process submissions that have an assigned player
          if (!submission.assignedPlayerId) {
            return null;
          }

          // Reload submission to get fresh data
          await submission.reload({
            include: [
              {
                model: Player,
                as: 'assignedPlayer',
                required: true,
              },
            ],
            transaction,
          });

          return submission;
        }),
      );

      // Filter out null values and ensure all required data exists
      const validSubmissions = matchingSubmissions.filter(
        (sub): sub is PassSubmission =>
          sub !== null &&
          !!sub.assignedPlayerId &&
          !!sub.flags &&
          !!sub.judgements &&
          !!sub.level,
      );

      const approvalResults = await Promise.all(
        validSubmissions.map(async submission => {
          try {
            // Validate level and difficulty data
            if (!submission.level) {
              await transaction.rollback();
              return {
                id: submission.id,
                success: false,
                error: 'Level data not found',
              };
            }

            if (!submission.level.difficulty) {
              await transaction.rollback();
              return {
                id: submission.id,
                success: false,
                error: 'Difficulty data not found',
              };
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
                playerId: submission.assignedPlayerId!,
                speed: submission.speed || 1,
                vidTitle: submission.title,
                videoLink: submission.videoLink,
                vidUploadTime: submission.rawTime || new Date(),
                is12K: submission.flags?.is12K || false,
                is16K: submission.flags?.is16K || false,
                isNoHoldTap: submission.flags?.isNoHoldTap || false,
                accuracy: calcAcc(
                  submission.judgements ||
                    ({
                      earlyDouble: 0,
                      earlySingle: 0,
                      ePerfect: 0,
                      perfect: 0,
                      lPerfect: 0,
                      lateSingle: 0,
                      lateDouble: 0,
                    } as IPassSubmissionJudgements),
                ),
                scoreV2: getScoreV2(
                  {
                    speed: submission.speed || 1,
                    judgements:
                      submission.judgements ||
                      ({
                        earlyDouble: 0,
                        earlySingle: 0,
                        ePerfect: 0,
                        perfect: 0,
                        lPerfect: 0,
                        lateSingle: 0,
                        lateDouble: 0,
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

            // Create judgements
            if (submission.judgements) {
              const now = new Date();
              await Judgement.create(
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
              );
            }

            // Update submission status
            await submission.update(
              {
                status: 'approved',
                passId: pass.id,
              },
              {transaction},
            );

            // Update level clear count
            await Level.increment('clears', {
              where: {id: submission.levelId},
              transaction,
            });

            // Update worlds first status if needed
            await updateWorldsFirstStatus(submission.levelId, transaction);

            // Update player stats
            if (submission.assignedPlayerId) {
              await playerStatsService.updatePlayerStats(
                submission.assignedPlayerId,
              );

              // Get player's new stats
              const playerStats = await playerStatsService.getPlayerStats(
                submission.assignedPlayerId,
              );

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
            }

            return {id: submission.id, success: true};
          } catch (error) {
            console.error(
              `Error auto-approving submission ${submission.id}:`,
              error,
            );
            return {id: submission.id, success: false, error};
          }
        }),
      );

      await transaction.commit();

      // Broadcast updates
      sseManager.broadcast({type: 'submissionUpdate'});
      sseManager.broadcast({
        type: 'submissionUpdate',
        data: {
          action: 'auto-approve',
          submissionType: 'pass',
          count: approvalResults.filter(r => r.success).length,
        },
      });

      const io = getIO();
      io.emit('leaderboardUpdated');

      return res.json({
        message: `Auto-approved ${
          approvalResults.filter(r => r.success).length
        } submissions`,
        results: approvalResults,
      });
    } catch (error) {
      await transaction.rollback();
      console.error('Error in auto-approve process:', error);
      return res.status(500).json({
        error: 'Failed to auto-approve submissions',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

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

    // Fetch fresh complete object with all associations
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
      await transaction.rollback();
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

    await transaction.commit();
    return res.json(submissionData);

  } catch (error) {
    await transaction.rollback();
    console.error('Error updating submission profiles:', error);
    return res.status(500).json({ error: 'Failed to update submission profiles' });
  }
});

// Assign creator to submission
router.put(
  '/levels/:id/assign-creator',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    const transaction = await sequelize.transaction();

    try {
      const { id } = req.params;
      const { creatorId, role, creditRequestId } = req.body;

      if (!creatorId || !role || !creditRequestId) {
        await transaction.rollback();
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
        await transaction.rollback();
        return res.status(404).json({ error: 'Submission not found' });
      }

      // Verify creator exists and get their name
      const creator = await Creator.findByPk(creatorId, { transaction });
      if (!creator) {
        await transaction.rollback();
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
        await transaction.rollback();
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
      await transaction.rollback();
      console.error('Error assigning creator:', error);
      return res.status(500).json({ error: 'Failed to assign creator' });
    }
  }
);

// Add endpoint to create and assign creator in one step
router.post('/levels/:id/creators', async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();

  try {
    const { id } = req.params;
    const { name, aliases, role } = req.body;

    if (!name || !role) {
      await transaction.rollback();
      return res.status(400).json({ error: 'Name and role are required' });
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
      await transaction.rollback();
      return res.status(404).json({ error: 'Submission not found' });
    }

    if (role === 'team') {
      // Handle team creation/assignment
      if (!submission.teamRequestData?.isNewRequest) {
        await transaction.rollback();
        return res.status(404).json({ error: 'No pending team request found' });
      }

      // Create or find team
      const [team] = await Team.findOrCreate({
        where: { name: name.trim() },
        defaults: {
          aliases: aliases || []
        },
        transaction
      });

      // Update the team request
      await LevelSubmissionTeamRequest.update({
        teamId: team.id,
        teamName: team.name,
        isNewRequest: false
      }, {
        where: { submissionId: id },
        transaction
      });
    } else {
      // Handle creator creation/assignment
      const existingRequest = submission.creatorRequests?.find(
        (request: any) => request.role === role && request.isNewRequest
      );

      if (!existingRequest) {
        await transaction.rollback();
        return res.status(404).json({ error: 'No pending creator request found for this role' });
      }

      // Create or find creator
      const [creator] = await Creator.findOrCreate({
        where: { name: name.trim() },
        defaults: {
          aliases: aliases || [],
          isVerified: false
        },
        transaction
      });

      // Update the credit request
      await LevelSubmissionCreatorRequest.update({
        creatorId: creator.id,
        creatorName: creator.name,
        isNewRequest: false
      }, {
        where: {
          id: existingRequest.id,
          submissionId: id
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
    await transaction.rollback();
    console.error('Error creating and assigning creator:', error);
    return res.status(500).json({ error: 'Failed to create and assign creator' });
  }
});

export default router;
