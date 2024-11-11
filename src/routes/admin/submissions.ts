import express, {Request, Response, Router} from 'express';
const router: Router = express.Router();
import Submission from '../../models/ChartSubmission';
import Level from '../../models/Level';

// Now use relative paths (without /v2/admin)
router.get('/pending', async (req: Request, res: Response) => {
  try {
    const pendingSubmissions = await Submission.find({ status: 'pending' });
    res.json(pendingSubmissions);
  } catch (error) {
    res.status(500).json({ error: error});
  }
});

router.put('/:id/:action', async (req: Request, res: Response) => {
  const { id, action } = req.params;
  
  try {
    if (action === 'approve') {
      const submission = await Submission.findById(id);
      
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
        diff: parseFloat(submission.diff) || 0,
        legacyDiff: parseFloat(submission.diff) || 0,
        pguDiff: "",
        pguDiffNum: parseFloat(submission.diff) || 0,
        newDiff: 0,
        pdnDiff: parseFloat(submission.diff) || 0,
        realDiff: 0,
        baseScore: 0,
        isCleared: false,
        clears: 0,
        vidLink: submission.videoLink,
        dlLink: submission.directDL,
        workshopLink: submission.wsLink || "",
        publicComments: "",
        toRate: true
      });

      await newLevel.save();

      await Submission.findByIdAndUpdate(id, {
        status: 'approved',
        toRate: true
      });

      return res.json({ message: 'Submission approved and level created successfully' });
    } else if (action === 'decline') {
      await Submission.findByIdAndUpdate(id, {
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

export default router;