import express, {Request, Response, Router} from 'express';
import { verifyAccessToken } from '../../utils/authHelpers';
import { raterList } from '../../config/constants';
import { Rating } from '../../models/Rating';

const router: Router = express.Router();

router.get("/raters", async (req: Request, res: Response) => {
  return res.json(raterList);
}); 

router.get("/", async (req: Request, res: Response) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return res.status(401).json({ error: 'Authorization token required' });
      }
  
      const accessToken = authHeader.split(' ')[1];
      const tokenInfo = await verifyAccessToken(accessToken);
  
      if (!tokenInfo || !raterList.includes(tokenInfo.username)) {
        return res.status(403).json({ error: 'Unauthorized access' });
      }
  
      const ratings = await Rating.find({}).sort({ ID: 1 });
      return res.json(ratings);
      
    } catch (error) {
      console.error('Error fetching rating list:', error);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
});
  
router.put("/", async (req: Request, res: Response) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return res.status(401).json({ error: 'Authorization token required' });
      }
  
      const accessToken = authHeader.split(' ')[1];
      const tokenInfo = await verifyAccessToken(accessToken);
  
      if (!tokenInfo || !raterList.includes(tokenInfo.username)) {
        return res.status(403).json({ error: 'Unauthorized access' });
      }
  
      const { updates } = req.body;
      if (!updates || !Array.isArray(updates)) {
        return res.status(400).json({ error: 'Updates array is required' });
      }
  
      // Process each update
      for (const update of updates) {
        const rating = await Rating.findOne({ ID: update.id });
        if (rating) {
          // Initialize ratings object if it doesn't exist
          if (!rating.ratings) {
            rating.ratings = {};
          }
          
          // Update the ratings object with the new rating and comment
          rating.ratings[tokenInfo.username] = [update.rating, update.comment];
          
          // Calculate new average
          const ratingValues = Object.values(rating.ratings)
            .map((r: any) => r[0])
            .filter((r: number) => r > 0);
            
          rating.average = ratingValues.length > 0 
            ? ratingValues.reduce((a: number, b: number) => a + b, 0) / ratingValues.length 
            : 0;
          
          // Update comments if provided
          if (update.comment) {
            rating.comments = update.comment;
          }
          
          await rating.save();
        }
      }
      
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