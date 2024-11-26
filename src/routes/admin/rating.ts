import express, {Request, Response, Router} from 'express';
import { verifyAccessToken } from '../../utils/authHelpers';
import { raterList } from '../../config/constants';
import { Rating } from '../../models/Rating';
import { calculateAverageRating } from '../../utils/ratingUtils';
import { Auth } from '../../middleware/auth';
import { IUser } from '../../types/express';

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
  
router.put("/", Auth.rater(), async (req: Request, res: Response) => {
      try {
        const userInfo = req.user as IUser;
        const { updates } = req.body;
        if (!updates || !Array.isArray(updates)) {
            return res.status(400).json({ error: 'Updates array is required' });
          }
  
          // Process each update
        for (const update of updates) {
            const rating = await Rating.findOne({ ID: update.id });
              if (rating) {
              // Initialize or update the ratings object
              const updatedRatings = {
                 ...(rating.ratings || {}),  // Spread existing ratings or empty object if none
                [userInfo.username]: [update.rating, update.comment]  // Add/update current user's rating
              };

              rating.ratings = updatedRatings;
              
              // Calculate new average using the rating utils
              const averageRating = calculateAverageRating(updatedRatings);
              console.log(`Average rating: ${averageRating}`);
              rating.average = averageRating || ''; // Use empty string if null
          
              await rating.save();
        } else {
          return res.status(404).json({ error: `Rating with ID ${update.id} not found` });
        }
      }
      
      return res.json({ 
        success: true, 
        message: `Ratings updated successfully by ${userInfo.username}` 
      });
  
    } catch (error) {
      console.error('Error updating ratings:', error);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.delete("/", Auth.superAdmin(), async (req: Request, res: Response) => {
  const { id } = req.body;
  await Rating.findByIdAndDelete(id);
  return res.json({ success: true });
});

export default router;