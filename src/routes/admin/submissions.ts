import express, {Request, Response, Router} from 'express';
const router: Router = express.Router();
import Submission from '../../models/ChartSubmission';

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
      await Submission.findByIdAndUpdate(id, {
        status: 'approved',
        toRate: true
      });
    } else if (action === 'decline') {
      await Submission.findByIdAndUpdate(id, {
        status: 'declined'
      });
    }
    
    res.json({ message: `Submission ${action}d successfully` });
  } catch (error) {
    res.status(500).json({ error: error });
  }
});

export default router;