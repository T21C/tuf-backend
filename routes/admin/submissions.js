import express from 'express';
const router = express.Router();
import Submission from '../../models/ChartSubmission.js';

// Now use relative paths (without /v2/admin)
router.get('/pending', async (req, res) => {
  try {
    const pendingSubmissions = await Submission.find({ status: 'pending' });
    res.json(pendingSubmissions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id/:action', async (req, res) => {
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
    res.status(500).json({ error: error.message });
  }
});

export default router;