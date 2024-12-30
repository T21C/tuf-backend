import { Router, Request, Response } from 'express';
import { Auth } from '../../middleware/auth';
import Rating from '../../models/Rating';
import LevelSubmission from '../../models/LevelSubmission';
import { PassSubmission } from '../../models/PassSubmission';
import Level from '../../models/Level';
import RatingDetail from '../../models/RatingDetail';
import { Op, Sequelize } from 'sequelize';

interface IUser {
  id: string;
  username: string;
  avatar?: string;
  discriminator: string;
  public_flags: number;
  flags: number;
  banner?: string;
  accent_color?: number;
  global_name?: string;
  avatar_decoration_data?: {
    asset: string;
    sku_id: string;
    expires_at: string | null;
  };
  banner_color?: string;
  clan?: string | null;
  primary_guild?: string | null;
  mfa_enabled: boolean;
  locale: string;
  premium_type: number;
  email: string;
  verified: boolean;
  access_token: string;
}

const router: Router = Router();

router.get('/', Auth.rater(), async (req: Request, res: Response) => {
  try {
    const user = req.user as IUser;
    if (!user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Get unrated ratings count using a subquery
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
            `(SELECT ratingId FROM rating_details WHERE username = '${user.username}')`
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
