import express, {Request, Response, Router} from 'express';
import { verifyAccessToken } from '../../utils/authHelpers';
import { raterList } from '../../config/constants';
import Rating from '../../models/Rating';
import RatingDetail from '../../models/RatingDetail';
import { calculateAverageRating } from '../../utils/ratingUtils';
import { Auth } from '../../middleware/auth';
import { IUser } from '../../types/express';
import { getIO } from '../../utils/socket';

const router: Router = express.Router();

router.get("/raters", async (req: Request, res: Response) => {
  return res.json(raterList);
}); 

router.get("/", Auth.rater(), async (req: Request, res: Response) => {
    try {
      const ratings = await Rating.findAll({
        include: [{
          model: RatingDetail,
          attributes: ['username', 'rating', 'comment']
        }],
        order: [['levelId', 'ASC']]
      });
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
            let rating = await Rating.findOne({ where: { levelId: update.id } });
            
            if (!rating) {
              // Create new rating if it doesn't exist
              rating = await Rating.create({ levelId: update.id });
            }

            // Update or create rating detail
            await RatingDetail.upsert({
              ratingId: rating.levelId,
              username: userInfo.username,
              rating: update.rating,
              comment: update.comment || ''
            });

            // Get all rating details for this level
            const ratingDetails = await RatingDetail.findAll({
              where: { ratingId: rating.levelId }
            });

            // Calculate new average using the rating details
            const averageRating = calculateAverageRating(ratingDetails);
            
            // Update the main rating record
            rating.average = averageRating || '';
            await rating.save();
        }
      
        // Emit the event using the socket utility
        const io = getIO();
        io.emit('ratingsUpdated');

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
  try {
    const { id } = req.body;
    // Delete rating details first due to foreign key constraint
    await RatingDetail.destroy({ where: { ratingId: id } });
    // Then delete the main rating
    await Rating.destroy({ where: { levelId: id } });
    return res.json({ success: true });
  } catch (error) {
    console.error('Error deleting rating:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

export default router;