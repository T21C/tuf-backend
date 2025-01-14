import {Request, Response, Router} from 'express';
import {Auth} from '../../middleware/auth';
import {PassSubmission, PassSubmissionFlags, PassSubmissionJudgements} from '../../models/PassSubmission';
import Pass from '../../models/Pass';
import Level from '../../models/Level';
import Difficulty from '../../models/Difficulty';
import Judgement from '../../models/Judgement';
import {calcAcc} from '../../misc/CalcAcc';
import {getScoreV2} from '../../misc/CalcScore';
import {getIO} from '../../utils/socket';
import sequelize from '../../config/db';
import {sseManager} from '../../utils/sse';
import {excludePlaceholder} from '../../middleware/excludePlaceholder';
import {PlayerStatsService} from '../../services/PlayerStatsService';
import {updateWorldsFirstStatus} from '../database/passes';
import {IPassSubmission, IJudgement, IPassSubmissionJudgements} from '../../interfaces/models';
import LevelSubmission from '../../models/LevelSubmission';
import Rating from '../../models/Rating';
import Player from '../../models/Player';
import {Op} from 'sequelize';

const router: Router = Router();
const playerStatsService = PlayerStatsService.getInstance();

// Get all level submissions
router.get('/levels', excludePlaceholder.fromResponse(), async (req: Request, res: Response) => {
  try {
    const levelSubmissions = await LevelSubmission.findAll();
    return res.json(levelSubmissions);
  } catch (error) {
    console.error('Error fetching level submissions:', error);
    return res.status(500).json({error: 'Failed to fetch level submissions'});
  }
});

// Get pending level submissions
router.get('/levels/pending', async (req: Request, res: Response) => {
  try {
    const pendingLevelSubmissions = await LevelSubmission.findAll({
      where: {status: 'pending'},
    });
    return res.json(pendingLevelSubmissions);
  } catch (error) {
    console.error('Error fetching pending level submissions:', error);
    return res.status(500).json({error: 'Failed to fetch pending level submissions'});
  }
});

// Get all pass submissions
router.get('/passes', excludePlaceholder.fromResponse(), async (req: Request, res: Response) => {
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
});

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
      ],
      order: [['createdAt', 'DESC']],
    });
    return res.json(submissions);
  } catch (error) {
    console.error('Error fetching pending pass submissions:', error);
    return res.status(500).json({error: 'Failed to fetch pending pass submissions'});
  }
});

// Handle level submission actions (approve/reject)
router.put('/levels/:id/:action', Auth.superAdmin(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();

  try {
    const {id, action} = req.params;
    
    if (action === 'approve') {
      const submissionObj = await LevelSubmission.findOne({
        where: {id},
        transaction,
      });

      if (!submissionObj) {
        await transaction.rollback();
        return res.status(404).json({error: 'Submission not found'});
      }

      const submission = submissionObj.dataValues;
      const lastLevel = await Level.findOne({
        order: [['id', 'DESC']],
        transaction,
      });
      const nextId = lastLevel ? lastLevel.id + 1 : 1;

      const newLevel = await Level.create({
        id: nextId,
        song: submission.song,
        artist: submission.artist,
        creator: submission.charter,
        charter: submission.charter,
        vfxer: submission.vfxer,
        team: submission.team,
        videoLink: submission.videoLink,
        dlLink: submission.directDL,
        workshopLink: submission.wsLink,
        toRate: true,
        isDeleted: false,
        diffId: 0,
        baseScore: 0,
        isCleared: false,
        isVerified: false,
        clears: 0,
        publicComments: '',
        submitterDiscordId: submission.submitterDiscordId,
        rerateReason: '',
        rerateNum: '',
        previousDiffId: 0,
        isAnnounced: false,
        isHidden: false,
      }, {transaction});

      // Create rating since toRate is true
      await Rating.create({
        levelId: newLevel.id,
        currentDifficultyId: 0,
        lowDiff: /^[pP]\d/.test(submission.diff),
        requesterFR: submission.diff,
        averageDifficultyId: null,
      }, {transaction});

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
    } else if (action === 'reject') {
      await LevelSubmission.update(
        {status: 'rejected'},
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
          action: 'reject',
          submissionId: id,
          submissionType: 'level',
        },
      });

      return res.json({message: 'Submission rejected successfully'});
    } else {
      await transaction.rollback();
      return res.status(400).json({error: 'Invalid action'});
    }
  } catch (error) {
    await transaction.rollback();
    console.error('Error processing level submission:', error);
    return res.status(500).json({error: 'Failed to process level submission'});
  }
});

// Handle pass submission actions (approve/reject/assign-player)
router.put('/passes/:id/:action', Auth.superAdmin(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();

  try {
    const {id, action} = req.params;

    if (action === 'approve') {
      const submission = await PassSubmission.findOne({
        where: {id},
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
          accuracy: calcAcc(submission.judgements || {
            earlyDouble: 0,
            earlySingle: 0,
            ePerfect: 0,
            perfect: 0,
            lPerfect: 0,
            lateSingle: 0,
            lateDouble: 0,
          } as IPassSubmissionJudgements),
          scoreV2: getScoreV2(
            {
              speed: submission.speed || 1,
              judgements: submission.judgements || {
                earlyDouble: 0,
                earlySingle: 0,
                ePerfect: 0,
                perfect: 0,
                lPerfect: 0,
                lateSingle: 0,
                lateDouble: 0,
              } as IPassSubmissionJudgements,
              isNoHoldTap: submission.flags?.isNoHoldTap || false,
            },
            {
              baseScore: submission.level?.baseScore || 0,
              difficulty: submission.level?.difficulty,
            },
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
        await playerStatsService.updatePlayerStats(submission.assignedPlayerId);

        // Get player's new stats
        const playerStats = await playerStatsService.getPlayerStats(submission.assignedPlayerId);

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
    } else if (action === 'reject') {
      await PassSubmission.update(
        {status: 'rejected'},
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
          action: 'reject',
          submissionId: id,
          submissionType: 'pass',
        },
      });

      return res.json({message: 'Pass submission rejected successfully'});
    } else if (action === 'assign-player') {
      const {playerId} = req.body;
      const submission = await PassSubmission.findByPk(id, {transaction});

      if (!submission) {
        await transaction.rollback();
        return res.status(404).json({error: 'Submission not found'});
      }

      await submission.update({assignedPlayerId: playerId}, {transaction});
      await transaction.commit();

      return res.json({message: 'Player assigned successfully'});
    } else {
      await transaction.rollback();
      return res.status(400).json({error: 'Invalid action'});
    }
  } catch (error) {
    await transaction.rollback();
    console.error('Error processing pass submission:', error);
    return res.status(500).json({error: 'Failed to process pass submission'});
  }
});

// Auto-approve pass submissions
router.post('/auto-approve/passes', Auth.superAdmin(), async (req: Request, res: Response) => {
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
      ],
      transaction,
    });

    const matchingSubmissions = await Promise.all(
      pendingSubmissions.map(async (submission) => {
        // First check if there's already an assigned player
        if (submission.assignedPlayerId) {
          return submission;
        }

        // If no assigned player, try to match by Discord ID
        if (!submission.submitterDiscordId) {
          return null;
        }

        // Find player with matching Discord ID
        const matchingPlayer = await Player.findOne({
          where: {
            discordId: submission.submitterDiscordId,
          },
          transaction,
        });

        if (!matchingPlayer) {
          return null;
        }

        // Assign the player
        await submission.update(
          {assignedPlayerId: matchingPlayer.id},
          {transaction},
        );

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
      validSubmissions.map(async (submission) => {
        try {
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
              accuracy: calcAcc(submission.judgements || {
                earlyDouble: 0,
                earlySingle: 0,
                ePerfect: 0,
                perfect: 0,
                lPerfect: 0,
                lateSingle: 0,
                lateDouble: 0,
              } as IPassSubmissionJudgements),
              scoreV2: getScoreV2(
                {
                  speed: submission.speed || 1,
                  judgements: submission.judgements || {
                    earlyDouble: 0,
                    earlySingle: 0,
                    ePerfect: 0,
                    perfect: 0,
                    lPerfect: 0,
                    lateSingle: 0,
                    lateDouble: 0,
                  } as IPassSubmissionJudgements,
                  isNoHoldTap: submission.flags?.isNoHoldTap || false,
                },
                {
                  baseScore: submission.level?.baseScore || 0,
                  difficulty: submission.level?.difficulty,
                },
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
            await playerStatsService.updatePlayerStats(submission.assignedPlayerId);

            // Get player's new stats
            const playerStats = await playerStatsService.getPlayerStats(submission.assignedPlayerId);

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
          console.error(`Error auto-approving submission ${submission.id}:`, error);
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
        count: approvalResults.filter((r) => r.success).length,
      },
    });

    const io = getIO();
    io.emit('leaderboardUpdated');

    return res.json({
      message: `Auto-approved ${
        approvalResults.filter((r) => r.success).length
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
});

export default router;
