import express, {Request, Response, Router} from 'express';
import {requireAuth} from '../middleware/auth';
import {raterList} from '../config/constants';
import {readJsonFile, writeJsonFile} from '../utils/fileHandlers';
import {PATHS} from '../config/constants';
import fs from 'fs';
import { fetchRatings } from '../utils/updateHelpers';

interface AuthRequest extends Request {
  user: {
    username: string;
    // add other user properties if needed
  }
}

const router: Router = express.Router();

router.get('/rating', requireAuth(raterList), async (req: Request, res: Response) => {
  try {
    if (fs.existsSync(PATHS.ratingListJson)) {
      const cachedRatingList = readJsonFile(PATHS.ratingListJson);
      return res.json(cachedRatingList);
    } else {
      console.log('fetching rating list');
      await fetchRatings();
      const freshRatingList = readJsonFile(PATHS.ratingListJson);
      return res.json(freshRatingList);
    }
  } catch (error) {
    console.error('Error fetching rating list:', error);
    return res.status(500).json({error: 'Internal Server Error'});
  }
});

router.put('/rating', requireAuth(raterList), async (req: Request, res: Response) => {
  try {
    const { updates } = req.body;

    if (!updates || !Array.isArray(updates)) {
      return res.status(400).json({error: 'Updates array is required'});
    }

    const ratingList = readJsonFile(PATHS.ratingListJson);

    const userColumnIndex = ratingList[0].findIndex(
      (header: string, index: number) =>
        index >= 4 && header === req.user?.username,
    );

    if (userColumnIndex === -1) {
      return res.status(400).json({error: 'User column not found'});
    }

    updates.forEach(update => {
      if (update.index < ratingList.length) {
        ratingList[update.index + 1][userColumnIndex] = update.rating;
        ratingList[update.index + 1][12] = update.comment;
      }
    });

    ratingList.lastUpdated = new Date().toISOString();
    ratingList.lastUpdatedBy = req.user?.username;

    writeJsonFile(PATHS.ratingListJson, ratingList);

    return res.json({
      success: true,
      message: `Ratings updated successfully by ${req.user?.username}`,
    });
  } catch (error) {
    console.error('Error updating ratings:', error);
    return res.status(500).json({error: 'Internal Server Error'});
  }
});

export default router;
