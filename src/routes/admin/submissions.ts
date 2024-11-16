import express, {Request, Response, Router} from 'express';
const router: Router = express.Router();
import ChartSubmission from '../../models/ChartSubmission';
import PassSubmission from '../../models/PassSubmission';
import Level from '../../models/Level';
import Pass from '../../models/Pass';
import { Rating } from '../../models/Rating';
import { calcAcc } from '../../misc/CalcAcc';
import { getScoreV2 } from '../../misc/CalcScore';

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

// Now use relative paths (without /v2/admin)
router.get('/charts/pending', async (req: Request, res: Response) => {
  try {
    const pendingChartSubmissions = await ChartSubmission.find({ status: 'pending' });
    res.json(pendingChartSubmissions);
  } catch (error) {
    res.status(500).json({ error: error});
  }
});

router.get('/passes/pending', async (req: Request, res: Response) => {
  try {
    const pendingPassSubmissions = await PassSubmission.find({ status: 'pending' });
    res.json(pendingPassSubmissions);
  } catch (error) {
    res.status(500).json({ error: error});
  }
});

router.put('/charts/:id/:action', async (req: Request, res: Response) => {
  const { id, action } = req.params;
  
  try {
    if (action === 'approve') {
      const submission = await ChartSubmission.findById(id);
      
      if (!submission) {
        return res.status(404).json({ error: 'Submission not found' });
      }

      const lastLevel = await Level.findOne().sort({ id: -1 });
      const nextId = lastLevel ? lastLevel.id + 1 : 1;

      const newLevel = new Level({
        id: nextId,
        song: submission.song,
        artist: submission.artist,
        creator: submission.charter,
        charter: submission.charter,
        vfxer: submission.vfxer || "",
        team: submission.team || "",
        vidLink: submission.videoLink,
        dlLink: submission.directDL,
        workshopLink: submission.wsLink || "",
        toRate: true
      });

      const newRating = new Rating({
        ID: nextId,
        song: submission.song,
        artist: submission.artist,
        creator: submission.charter,
        rawVideoLink: submission.videoLink,
        rawDLLink: submission.directDL,
        requesterFR: submission.diff,
      });

      await Promise.all([newLevel.save(), newRating.save()]);

      await ChartSubmission.findByIdAndUpdate(id, {
        status: 'approved',
        toRate: true
      });

      return res.json({ message: 'Submission approved, level and rating created successfully' });
    } else if (action === 'decline') {
      await ChartSubmission.findByIdAndUpdate(id, {
        status: 'declined'
      });
      return res.json({ message: 'Submission declined successfully' });
    } else {
      return res.status(400).json({ error: 'Invalid action' });
    }
  } catch (error) {
    console.error('Error processing submission:', error);
    return res.status(500).json({ error: error });
  }
});


router.put('/passes/:id/:action', async (req: Request, res: Response) => {
  const { id, action } = req.params;
  
  try {
    if (action === 'approve') {
      const submission = await PassSubmission.findById(id);
      
      if (!submission) {
        return res.status(404).json({ error: 'Submission not found' });
      }

      const lastPass = await Pass.findOne().sort({ id: -1 });
      const nextId = lastPass ? lastPass.id + 1 : 1;

      // Create pass data object that matches the interface
      const passData: PassData = {
        judgements: submission.judgements, // Already in the correct format
        speed: submission.speed,
        flags: submission.flags
      };

      const accuracy = calcAcc(passData.judgements, true);
      const score = getScoreV2(passData, { diff: 0, baseScore: 1000 }); // Add chart data as needed

      const newPass = new Pass({
        id: nextId,
        levelId: submission.levelId,
        speed: submission.speed,
        player: submission.passer,
        feelingDifficulty: submission.feelingDifficulty,
        vidTitle: submission.title,
        vidLink: submission.rawVideoId,
        vidUploadTime: submission.rawTime,
        is12k: submission.flags.is12k,
        isNHT: submission.flags.isNHT,
        is16k: submission.flags.is16k,
        accuracy,
        scoreV2: score,
        judgements: submission.judgements
      });

      await newPass.save();
      await PassSubmission.findByIdAndUpdate(id, { status: 'approved' });

      return res.json({ 
        message: 'Pass submission approved successfully',
        passId: newPass.id 
      });
    } else if (action === 'decline') {
      await PassSubmission.findByIdAndUpdate(id, { status: 'declined' });
      return res.json({ message: 'Submission declined successfully' });
    } else {
      return res.status(400).json({ error: 'Invalid action' });
    }
  } catch (error) {
    console.error('Error processing submission:', error);
    return res.status(500).json({ error: error });
  }
});

export default router;