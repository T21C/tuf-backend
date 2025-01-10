import { Router, Request, Response } from 'express';
import { Auth } from '../../middleware/auth';
import Rating from '../../models/Rating';
import LevelSubmission from '../../models/LevelSubmission';
import { PassSubmission } from '../../models/PassSubmission';
import Level from '../../models/Level';
import RatingDetail from '../../models/RatingDetail';
import { Op, Sequelize } from 'sequelize';
import { UserAttributes } from '../../models/User';


const router: Router = Router();

router.get('/', Auth.rater(), async (req: Request, res: Response) => {
  try {
    const user = req.user as UserAttributes;
    if (!user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Get unrated ratings count using a proper subquery
    const unratedRatings = await Rating.findAll({
      include: [{
        model: Level,
        as: 'level',
        where: {
          toRate: true
        },
        required: true
      }],
      where: {
        id: {
          [Op.notIn]: Sequelize.literal(
            `(SELECT DISTINCT "ratingId" FROM rating_details WHERE userId = '${user.id}')`
          )
        }
      }
    });

    // Get pending level submissions count
    const pendingLevelSubmissions = await LevelSubmission.count({
      where: {
        status: 'pending'
      }
    });

    // Get pending pass submissions count
    const pendingPassSubmissions = await PassSubmission.count({
      where: {
        status: 'pending'
      }
    });

    // Calculate total pending submissions
    const totalPendingSubmissions = pendingLevelSubmissions + pendingPassSubmissions;

    return res.json({
      unratedRatings: unratedRatings.length,
      pendingLevelSubmissions,
      pendingPassSubmissions,
      totalPendingSubmissions
    });

  } catch (error) {
    console.error('Error fetching statistics:', error);
    return res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

export default router;
