import {Router, Request, Response} from 'express';
import {Auth} from '../../middleware/auth.js';
import Rating from '../../models/levels/Rating.js';
import LevelSubmission from '../../models/submissions/LevelSubmission.js';
import {PassSubmission} from '../../models/submissions/PassSubmission.js';
import Level from '../../models/levels/Level.js';
import RatingDetail from '../../models/levels/RatingDetail.js';
import { logger } from '../../services/LoggerService.js';
import { filterRatingsByUserTopDiff } from '../../utils/RatingUtils.js';

const router: Router = Router();

router.get('/', Auth.rater(), async (req: Request, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({error: 'User not authenticated'});
    }
    
    // Get unrated ratings count using a proper subquery
    const allRatings = await Rating.findAll({
      where: {
        confirmedAt: null
      },
      include: [
        {
          model: Level,
          as: 'level',
          where: {
            isDeleted: false,
            isHidden: false,
          }
        },
        {
          model: RatingDetail,
          as: 'details',
          attributes: []
        }
      ],
      order: [['levelId', 'ASC']],
    });

    const unratedRatings = allRatings.filter(
      (rating: Rating) => 
        !/^vote/i.test(rating.level?.rerateNum || '')
      &&
        (rating.details?.length || 0) < 4
    );

    const currentRatingsCount = await RatingDetail.count({
      where: {
        userId: user.id
      },
      include: [
        {
          model: Rating,
          as: 'parentRating',
          where: {
            confirmedAt: null
          }
        }
      ]
    });

    // Apply the same filtering logic as the frontend
    const filteredUnrated = await filterRatingsByUserTopDiff(unratedRatings, user);
    // Get pending level submissions count
    const pendingLevelSubmissions = await LevelSubmission.count({
      where: {
        status: 'pending',
      },
    });

    // Get pending pass submissions count
    const pendingPassSubmissions = await PassSubmission.count({
      where: {
        status: 'pending',
      },
    });

    // Calculate total pending submissions
    const totalPendingSubmissions =
      pendingLevelSubmissions + pendingPassSubmissions;
    return res.json({
      unratedRatings: filteredUnrated.length - currentRatingsCount,
      pendingLevelSubmissions,
      pendingPassSubmissions,
      totalPendingSubmissions,
    });
  } catch (error) {
    logger.error('Error fetching statistics:', error);
    return res.status(500).json({error: 'Failed to fetch statistics'});
  }
});

export default router;
