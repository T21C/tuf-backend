import express, {Request, Response, Router} from 'express';
const router: Router = express.Router();
import ChartSubmission from '../../models/ChartSubmission';
import { PassSubmission, PassSubmissionJudgements, PassSubmissionFlags } from '../../models/PassSubmission';
import Level from '../../models/Level';
import Pass from '../../models/Pass';
import Rating from '../../models/Rating';
import { calcAcc } from '../../misc/CalcAcc';
import { getScoreV2 } from '../../misc/CalcScore'; 
import { Auth } from '../../middleware/auth';
import sequelize from '../../config/db';
import Player from '../../models/Player';
import Judgement from '../../models/Judgement';
import { Op } from 'sequelize';
import { IJudgement } from '../../types/models';

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
    is12k: boolean;
    isNHT: boolean;
    is16k: boolean;
  };
}

// Helper function to get or create player ID
async function getOrCreatePlayerId(playerName: string): Promise<number> {
  const [player] = await Player.findOrCreate({
    where: { name: playerName },
    defaults: {
      name: playerName,
      country: 'XX',
      isBanned: false
    }
  });
  return player.id;
}

// Now use relative paths (without /v2/admin)
router.get('/charts/pending', async (req: Request, res: Response) => {
  try {
    const pendingChartSubmissions = await ChartSubmission.findAll({ where: { status: 'pending' } });
    res.json(pendingChartSubmissions);
  } catch (error) {
    res.status(500).json({ error: error});
  }
});

router.get('/passes/pending', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    const submissions = await PassSubmission.findAll({
      where: { status: 'pending' },
      include: [
        {
          model: PassSubmissionJudgements,
          as: "PassSubmissionJudgement",
          required: true
        },
        {
          model: PassSubmissionFlags,
          as: "PassSubmissionFlag",
          required: true
        }
      ],
      order: [['createdAt', 'DESC']]
    });
    
    return res.json(submissions);
  } catch (error) {
    console.error('Error fetching pending pass submissions:', error);
    return res.status(500).json({ error: error });
  }
});

router.put('/charts/:id/:action', Auth.superAdmin(), async (req: Request, res: Response) => {
  const { id, action } = req.params;
  
  try {
    if (action === 'approve') {
      const submissionObj = await ChartSubmission.findOne({ where: { id } });
      
      
      if (!submissionObj) {
        return res.status(404).json({ error: 'Submission not found' });
      }

      const submission = submissionObj.dataValues;

      const lastLevel = await Level.findOne({ order: [['id', 'DESC']] });
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
        vidLink: submission.videoLink,
        dlLink: submission.directDL,
        workshopLink: submission.wsLink,
        toRate: true,
        isDeleted: false,
        diff: 0,
        legacyDiff: 0,
        pguDiff: '',
        pguDiffNum: 0,
        newDiff: 0,
        baseScore: 0,
        baseScoreDiff: '0',
        isCleared: false,
        clears: 0,
        publicComments: '',
        rerateReason: '',
        rerateNum: '',
        createdAt: new Date(),
        updatedAt: new Date()
      });

      // Create rating since toRate is true
      await Rating.create({
        levelId: newLevel.id,
        currentDiff: '0',
        lowDiff: false,
        requesterFR: '',
        average: '0'
      });

      await ChartSubmission.update(
        { status: 'approved', toRate: true },
        { where: { id } }
      );

      return res.json({ message: 'Submission approved, level and rating created successfully' });
    } else if (action === 'decline') {
      await ChartSubmission.update(
        { status: 'declined' },
        { where: { id } }
      );
      return res.json({ message: 'Submission declined successfully' });
    } else {
      return res.status(400).json({ error: 'Invalid action' });
    }
  } catch (error) {
    console.error('Error processing submission:', error);
    return res.status(500).json({ error: error });
  }
});


router.put('/passes/:id/:action', Auth.superAdmin(), async (req: Request, res: Response) => {
  const { id, action } = req.params;
  
  try {
    if (action === 'approve') {
      const submission = await PassSubmission.findOne({
        where: { id },
        include: [
          { 
            model: PassSubmissionJudgements,
            as: 'PassSubmissionJudgement',
            required: true 
          },
          { 
            model: PassSubmissionFlags,
            as: 'PassSubmissionFlag',
            required: true 
          }
        ]
      });
      
      if (!submission || !submission.PassSubmissionJudgement || !submission.PassSubmissionFlag) {
        return res.status(404).json({ error: 'Submission or its data not found' });
      }

      if (!submission.assignedPlayerId) {
        return res.status(400).json({ error: 'No player assigned to this submission' });
      }

      // Check if this is the first pass for this level
      const existingPasses = await Pass.count({
        where: {
          levelId: parseInt(submission.levelId),
          isDeleted: false
        }
      });

      // Get level data for score calculation
      const levelObj = await Level.findByPk(parseInt(submission.levelId));
      if (!levelObj) {
        return res.status(404).json({ error: 'Level not found' });
      }

      const level = levelObj.dataValues;
      console.log(level);

      // Calculate accuracy and score
      const judgements: Object = {
        earlyDouble: Number(submission.PassSubmissionJudgement.earlyDouble),
        earlySingle: Number(submission.PassSubmissionJudgement.earlySingle),
        ePerfect: Number(submission.PassSubmissionJudgement.ePerfect),
        perfect: Number(submission.PassSubmissionJudgement.perfect),
        lPerfect: Number(submission.PassSubmissionJudgement.lPerfect),
        lateSingle: Number(submission.PassSubmissionJudgement.lateSingle),
        lateDouble: Number(submission.PassSubmissionJudgement.lateDouble)
      };

      const accuracy = calcAcc(judgements, true);
      const scoreV2 = getScoreV2(
        {
          speed: Number(submission.speed) || 1,
          judgements: judgements,
          isNoHoldTap: Boolean(submission.PassSubmissionFlag.isNHT)
        },
        {
          diff: Number(level.legacyDiff) || 0,
          baseScore: Number(level.baseScore) || 0
        }
      );

      // Ensure scoreV2 is a valid number
      if (isNaN(scoreV2)) {
        console.error('ScoreV2 calculation resulted in NaN:', {
          speed: submission.speed,
          judgements,
          isNHT: submission.PassSubmissionFlag.isNHT,
          diff: level.legacyDiff,
          baseScore: level.baseScore
        });
        return res.status(400).json({ error: 'Invalid score calculation' });
      }

      // Create the pass with all its data
      const newPass = await Pass.create({
        levelId: parseInt(submission.levelId),
        playerId: submission.assignedPlayerId,
        speed: Number(submission.speed) || 1,
        feelingRating: submission.feelingDifficulty,
        vidTitle: submission.title,
        vidLink: submission.rawVideoId,
        vidUploadTime: submission.rawTime,
        is12K: Boolean(submission.PassSubmissionFlag.is12k),
        is16K: Boolean(submission.PassSubmissionFlag.is16k),
        isNoHoldTap: Boolean(submission.PassSubmissionFlag.isNHT),
        isLegacyPass: false,
        isWorldsFirst: existingPasses === 0,
        accuracy,
        scoreV2: scoreV2.toString(),
        isDeleted: false
      });

      // Create judgements
      await Judgement.create({
        passId: newPass.id,
        earlyDouble: submission.PassSubmissionJudgement.earlyDouble,
        earlySingle: submission.PassSubmissionJudgement.earlySingle,
        ePerfect: submission.PassSubmissionJudgement.ePerfect,
        perfect: submission.PassSubmissionJudgement.perfect,
        lPerfect: submission.PassSubmissionJudgement.lPerfect,
        lateSingle: submission.PassSubmissionJudgement.lateSingle,
        lateDouble: submission.PassSubmissionJudgement.lateDouble
      });

      // Update submission status
      await PassSubmission.update(
        { status: 'approved' },
        { where: { id } }
      );

      return res.json({ message: 'Pass submission approved successfully' });
    } else if (action === 'decline') {
      await PassSubmission.update(
        { status: 'declined' },
        { where: { id } }
      );
      return res.json({ message: 'Pass submission declined successfully' });
    } else if (action === 'assign-player') {
      const { playerId } = req.body;
      
      const submission = await PassSubmission.findByPk(id);
      if (!submission) {
        return res.status(404).json({ error: 'Submission not found' });
      }

      await submission.update({ assignedPlayerId: playerId });
      return res.json({ message: 'Player assigned successfully' });
    } else {
      return res.status(400).json({ error: 'Invalid action' });
    }
  } catch (error) {
    console.error('Error processing submission:', error);
    return res.status(500).json({ error: error });
  }
});

export default router;