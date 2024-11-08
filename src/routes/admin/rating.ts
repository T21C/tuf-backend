import express, {Request, Response, Router} from 'express';
import { verifyAccessToken } from '../../utils/authHelpers';
import { raterList } from '../../config/constants';
import { readJsonFile, writeJsonFile } from '../../utils/fileHandlers';
import { PATHS } from '../../config/constants';
import {fetchRatings} from '../../utils/updateHelpers';
import fs from 'fs';


const router: Router = express.Router();

router.get("/rating", async (req: Request, res: Response) => {
    try {
      // Get authorization token from header
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return res.status(401).json({ error: 'Authorization token required' });
      }
  
      // Verify token and get user info
      const accessToken = authHeader.split(' ')[1];
      const tokenInfo = await verifyAccessToken(accessToken);
  
      if (!tokenInfo || !raterList.includes(tokenInfo.username)) {
        return res.status(403).json({ error: 'Unauthorized access' });
      }
  
      // Continue with existing logic
      if (fs.existsSync(PATHS.ratingListJson)) {
        const cachedRatingList = readJsonFile(PATHS.ratingListJson);
        return res.json(cachedRatingList);
      }
      else {
        console.log("fetching rating list");
        await fetchRatings();
        const freshRatingList = readJsonFile(PATHS.ratingListJson);  // Read the newly fetched ratings
        return res.json(freshRatingList);
      }
    } catch (error) {
      console.error('Error fetching rating list:', error);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  });
  
  router.put("/rating", async (req: Request, res: Response) => {
    try {
      // Get authorization token from header
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return res.status(401).json({ error: 'Authorization token required' });
      }
  
      // Verify token and get user info
      const accessToken = authHeader.split(' ')[1];
      const tokenInfo = await verifyAccessToken(accessToken);
  
      if (!tokenInfo || !raterList.includes(tokenInfo.username)) {
        return res.status(403).json({ error: 'Unauthorized access' });
      }
  
      const { updates } = req.body;
      if (!updates || !Array.isArray(updates)) {
        return res.status(400).json({ error: 'Updates array is required' });
      }
  
      // Read current ratings
      const ratingList = readJsonFile(PATHS.ratingListJson);
      
      // Find the user's column index in the headers
      const userColumnIndex = ratingList[0].findIndex((header: string, index: number) => 
        index >= 4 && header === tokenInfo.username
      );
  
      if (userColumnIndex === -1) {
        return res.status(400).json({ error: 'User column not found' });
      }
  
      // Apply all updates
      updates.forEach(update => {
        if (update.index < ratingList.length) {
          // Update the rating in the user's column
          ratingList[update.index + 1][userColumnIndex] = update.rating;
          // Update the comment in column 12
          ratingList[update.index + 1][12] = update.comment;
        }
      });
  
      // Add metadata
      ratingList.lastUpdated = new Date().toISOString();
      ratingList.lastUpdatedBy = tokenInfo.username;
      
      // Save the updated ratings
      writeJsonFile(PATHS.ratingListJson, ratingList);
      
      return res.json({ 
        success: true, 
        message: `Ratings updated successfully by ${tokenInfo.username}` 
      });
  
    } catch (error) {
      console.error('Error updating ratings:', error);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  });

export default router;