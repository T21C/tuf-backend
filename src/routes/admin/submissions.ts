import express, {Request, Response, Router} from 'express';
const router: Router = express.Router();
import LevelSubmission from '../../models/LevelSubmission';
import {
  PassSubmission,
  PassSubmissionJudgements,
  PassSubmissionFlags,
} from '../../models/PassSubmission';
import Level from '../../models/Level';
import Pass from '../../models/Pass';
import Rating from '../../models/Rating';
import {calcAcc, IJudgements} from '../../misc/CalcAcc';
import {getScoreV2} from '../../misc/CalcScore';
import {Auth} from '../../middleware/auth';
import Player from '../../models/Player';
import Judgement from '../../models/Judgement';
import Difficulty from '../../models/Difficulty';
import {getBaseScore} from '../../utils/parseBaseScore';

// Define interfaces for the data structure
interface PassData {
  judgements: {
    earlyDouble: number;
    earlySingle: number;
    ePerfect: number;
    perfect: number;
    lPerfect: number;
    lateSingle: number;
    lateDouble: number;
  };
  speed?: number;
  flags: {
    is12K: boolean;
    isNoHoldTap: boolean;
    is16K: boolean;
  };
}

// Helper function to get or create player ID
async function getOrCreatePlayerId(playerName: string): Promise<number> {
  const [player] = await Player.findOrCreate({
    where: {name: playerName},
    defaults: {
      name: playerName,
      country: 'XX',
      isBanned: false,
    },
  });
  return player.id;
}

// Now use relative paths (without /v2/admin)
router.get('/levels/pending', async (req: Request, res: Response) => {
  try {
    const pendingLevelSubmissions = await LevelSubmission.findAll({
      where: {status: 'pending'},
    });
    res.json(pendingLevelSubmissions);
  } catch (error) {
    res.status(500).json({error: error});
  }
});

router.get(
  '/passes/pending',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    try {
      const submissions = await PassSubmission.findAll({
        where: {status: 'pending'},
        include: [
          {
            model: PassSubmissionJudgements,
            as: 'judgements',
            required: true,
          },
          {
            model: PassSubmissionFlags,
            as: 'flags',
            required: true,
          },
          {
            model: Player,
            as: 'assignedPlayer',
          },
        ],
        order: [['createdAt', 'DESC']],
      });

      return res.json(submissions);
    } catch (error) {
      console.error('Error fetching pending pass submissions:', error);
      return res.status(500).json({error: error});
    }
  },
);

router.put('/levels/:id/:action', Auth.superAdmin(), async (req: Request, res: Response) => {
    const {id, action} = req.params;

    try {
      if (action === 'approve') {
        const submissionObj = await LevelSubmission.findOne({where: {id}});

        if (!submissionObj) {
          return res.status(404).json({error: 'Submission not found'});
        }

        const submission = submissionObj.dataValues;

        const lastLevel = await Level.findOne({order: [['id', 'DESC']]});
        const nextId = lastLevel ? lastLevel.id + 1 : 1;

        console.log(submission);

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
          clears: 0,
          publicComments: '',
          submitterDiscordId: submission.submitterDiscordId,
          rerateReason: '',
          rerateNum: '',
          isAnnounced: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        });

        // Create rating since toRate is true
        await Rating.create({
          levelId: newLevel.id,
          currentDiff: '0',
          lowDiff: /^(p|P|[1-9]|1[0-9])(\+)?$/i.test(submission.diff),
          requesterFR: submission.diff,
          average: '0',
        });

        await LevelSubmission.update(
          {status: 'approved', toRate: true},
          {where: {id}},
        );

        return res.json({
          message: 'Submission approved, level and rating created successfully',
        });
      } else if (action === 'decline') {
        await LevelSubmission.update({status: 'declined'}, {where: {id}});
        return res.json({message: 'Submission declined successfully'});
      } else {
        return res.status(400).json({error: 'Invalid action'});
      }
    } catch (error) {
      console.error('Error processing submission:', error);
      return res.status(500).json({error: error});
    }
  },
);

router.put('/passes/:id/:action', Auth.superAdmin(), async (req: Request, res: Response) => {
    const {id, action} = req.params;

    try {
      if (action === 'approve') {
        const submission = await PassSubmission.findOne({
          where: {id},
          include: [
            {
              model: PassSubmissionJudgements,
              as: 'judgements',
              required: true,
            },
            {
              model: PassSubmissionFlags,
              as: 'flags',
              required: true,
            },
          ],
        });

        if (!submission || !submission.judgements || !submission.flags) {
          return res
            .status(404)
            .json({error: 'Submission or its data not found'});
        }

        if (!submission.assignedPlayerId) {
          return res
            .status(400)
            .json({error: 'No player assigned to this submission'});
        }

        // Check if this is the first pass for this level
        const existingPasses = await Pass.count({
          where: {
            levelId: submission.levelId,
            isDeleted: false,
          },
        });

        // Get level data for score calculation
        const levelObj = await Level.findByPk(submission.levelId, {
          include: [
            {
              model: Difficulty,
              as: 'difficulty',
              attributes: ['id', 'name', 'type', 'icon', 'baseScore', 'legacy'],
            },
          ],
        });
        if (!levelObj) {
          return res.status(404).json({error: 'Level not found'});
        }

        const level = levelObj.dataValues;
        console.log(level);

        // Calculate accuracy and score
        const judgements: IJudgements = {
          earlyDouble: Number(submission.judgements.earlyDouble),
          earlySingle: Number(submission.judgements.earlySingle),
          ePerfect: Number(submission.judgements.ePerfect),
          perfect: Number(submission.judgements.perfect),
          lPerfect: Number(submission.judgements.lPerfect),
          lateSingle: Number(submission.judgements.lateSingle),
          lateDouble: Number(submission.judgements.lateDouble),
        };

        const accuracy = calcAcc(judgements);
        const scoreV2 = getScoreV2(
          {
            speed: Number(submission.speed) || 1,
            judgements: judgements,
            isNoHoldTap: Boolean(submission.flags.isNoHoldTap),
          },
          {
            diff: Number(level.difficulty?.legacy) || 0,
            baseScore: getBaseScore(level),
            difficulty: level.difficulty,
          },
        );

        // Ensure scoreV2 is a valid number
        if (isNaN(scoreV2)) {
          console.error('ScoreV2 calculation resulted in NaN:', {
            speed: submission.speed,
            judgements,
            isNoHoldTap: submission.flags.isNoHoldTap,
            diff: level.difficulty?.legacy || 0,
            baseScore: getBaseScore(level),
          });
          return res.status(400).json({error: 'Invalid score calculation'});
        }

        // Create the pass with all its data
        const newPass = await Pass.create({
          levelId: submission.levelId,
          playerId: submission.assignedPlayerId,
          speed: Number(submission.speed) || 1,
          feelingRating: submission.feelingDifficulty,
          vidTitle: submission.title,
          videoLink: submission.videoLink,
          vidUploadTime: submission.rawTime,
          is12K: Boolean(submission.flags.is12K),
          is16K: Boolean(submission.flags.is16K),
          isNoHoldTap: Boolean(submission.flags.isNoHoldTap),
          isWorldsFirst: existingPasses === 0,
          accuracy,
          scoreV2,
          isDeleted: false,
        });

        // Create judgements
        await Judgement.create({
          id: newPass.id,
          earlyDouble: submission.judgements.earlyDouble,
          earlySingle: submission.judgements.earlySingle,
          ePerfect: submission.judgements.ePerfect,
          perfect: submission.judgements.perfect,
          lPerfect: submission.judgements.lPerfect,
          lateSingle: submission.judgements.lateSingle,
          lateDouble: submission.judgements.lateDouble,
          createdAt: new Date(),
          updatedAt: new Date(),
        });

        // Update submission status
        await PassSubmission.update({status: 'approved'}, {where: {id}});

        return res.json({message: 'Pass submission approved successfully'});
      } else if (action === 'decline') {
        await PassSubmission.update({status: 'declined'}, {where: {id}});
        return res.json({message: 'Pass submission declined successfully'});
      } else if (action === 'assign-player') {
        const {playerId} = req.body;

        const submission = await PassSubmission.findByPk(id);
        if (!submission) {
          return res.status(404).json({error: 'Submission not found'});
        }

        await submission.update({assignedPlayerId: playerId});
        return res.json({message: 'Player assigned successfully'});
      } else {
        return res.status(400).json({error: 'Invalid action'});
      }
    } catch (error) {
      console.error('Error processing submission:', error);
      return res.status(500).json({error: error});
    }
  },
);

export default router;
