import {Router, Request, Response} from 'express';
import {Auth} from '../../middleware/auth.js';
import Rating from '../../models/Rating.js';
import LevelSubmission from '../../models/LevelSubmission.js';
import {PassSubmission, PassSubmissionFlags, PassSubmissionJudgements} from '../../models/PassSubmission.js';
import Level from '../../models/Level.js';
import RatingDetail from '../../models/RatingDetail.js';
import {Sequelize} from 'sequelize';
import {UserAttributes} from '../../models/User.js';

const router: Router = Router();

router.get('/', Auth.rater(), async (req: Request, res: Response) => {
  try {
    const user = req.user as UserAttributes;
    if (!user) {
      return res.status(401).json({error: 'User not authenticated'});
    }

    const currentRatingsCount = await RatingDetail.count({
      where: {
        userId: user.id,
      },
    });
    // Get unrated ratings count using a proper subquery
    const unratedRatings = await Rating.findAll({
      include: [
        {
          model: Level,
          as: 'level',
          where: {
            toRate: true,
          },
          attributes: ['rerateNum'],
          required: true,
        },
        {
          model: RatingDetail,
          as: 'details',
          attributes: [],
        },
      ],
      attributes: ['id'],
      group: ['Rating.id'],
      having: Sequelize.literal('COUNT(`details`.`id`) < 4'),
    }).then(ratings => {
      return ratings.filter(rating => !/^vote/i.test(rating.level?.rerateNum || ''));
    });

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
      include: [
        {
          model: PassSubmissionJudgements,
          attributes: [],
          as: 'judgements',
          required: true,
        },
        {
          model: PassSubmissionFlags,
          attributes: [],
          as: 'flags',
          required: true,
        },
      ],
    });

    // Calculate total pending submissions
    const totalPendingSubmissions =
      pendingLevelSubmissions + pendingPassSubmissions;

    return res.json({
      unratedRatings: unratedRatings.length - currentRatingsCount,
      pendingLevelSubmissions,
      pendingPassSubmissions,
      totalPendingSubmissions,
    });
  } catch (error) {
    console.error('Error fetching statistics:', error);
    return res.status(500).json({error: 'Failed to fetch statistics'});
  }
});

export default router;
