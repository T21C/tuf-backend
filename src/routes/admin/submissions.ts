import {Request, Response, Router} from 'express';
import {Auth} from '../../middleware/auth';
import {PassSubmission} from '../../models/PassSubmission';
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

const router: Router = Router();
const playerStatsService = PlayerStatsService.getInstance();

router.put('/passes/:id/:action', Auth.superAdmin(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  try {
    const {id, action} = req.params;
    const submission = await PassSubmission.findOne({
      where: {id: parseInt(id)},
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
      ],
      transaction,
    });

    if (!submission) {
      await transaction.rollback();
      return res.status(404).json({error: 'Submission not found'});
    }

    if (action === 'approve') {
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
      await submission.update(
        {
          status: 'rejected',
        },
        {transaction},
      );

      await transaction.commit();

      return res.json({
        message: 'Pass submission rejected successfully',
      });
    } else {
      await transaction.rollback();
      return res.status(400).json({error: 'Invalid action'});
    }
  } catch (error) {
    await transaction.rollback();
    console.error('Error handling pass submission:', error);
    return res.status(500).json({
      error: 'Failed to handle pass submission',
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

export default router;
