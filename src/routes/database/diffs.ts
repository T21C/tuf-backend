import express, { Router } from 'express';
import Difficulty from '../../models/Difficulty';

const router: Router = express.Router();

router.get('/', async (req, res) => {
    try {
        const diffs = await Difficulty.findAll();
        const diffsList = diffs.map(diff => diff.toJSON());

        res.json(diffsList);
    } catch (error) {
        console.error('Error fetching difficulties:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default router;
