import {Router, Request, Response} from 'express';
import {Auth} from '../../middleware/auth.js';
import Rating from '../../models/levels/Rating.js';
import LevelSubmission from '../../models/submissions/LevelSubmission.js';
import {PassSubmission} from '../../models/submissions/PassSubmission.js';
import Level from '../../models/levels/Level.js';
import RatingDetail from '../../models/levels/RatingDetail.js';
import User from '../../models/auth/User.js';
import sequelize from '../../config/db.js';
import { Op } from 'sequelize';
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
    let filteredUnrated = unratedRatings;
    // Apply the same filtering logic as the frontend
    if (!user.isSuperAdmin) {
      filteredUnrated = await filterRatingsByUserTopDiff(unratedRatings, user);
    }
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

router.get('/ratings-per-user', async (req: Request, res: Response) => {
  try {
    // Get the date parameters from query string
    let { startDate, endDate, page = '1', limit = '20' } = req.query;
    
    // Parse pagination parameters
    const pageNum = parseInt(page as string) || 1;
    const limitNum = parseInt(limit as string) || 20;
    const offset = (pageNum - 1) * limitNum;

    // Parse the start date
    let selectedStartDate: Date;
    if (startDate) {
      selectedStartDate = new Date(startDate as string);
      if (isNaN(selectedStartDate.getTime())) {
        return res.status(400).json({error: 'Invalid start date format'});
      }
    } else {
      // Default to a week ago if no start date provided
      selectedStartDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    }

    // Parse the end date (optional)
    let selectedEndDate: Date | null = null;
    if (endDate) {
      selectedEndDate = new Date(endDate as string);
      if (isNaN(selectedEndDate.getTime())) {
        return res.status(400).json({error: 'Invalid end date format'});
      }
      // Set end date to end of day
      selectedEndDate.setHours(23, 59, 59, 999);
    }

    // Build the where clause for the date filter
    const dateFilter: any = {
      createdAt: {
        [Op.gte]: selectedStartDate
      }
    };

    // Add end date filter if provided
    if (selectedEndDate) {
      dateFilter.createdAt[Op.lte] = selectedEndDate;
    }

    // Get all active raters (users who have ratings in the date range)
    const activeRaters = await RatingDetail.findAll({
      attributes: [
        'userId',
        [sequelize.fn('COUNT', sequelize.col('RatingDetail.id')), 'ratingCount']
      ],
      where: dateFilter,
      include: [
        {
          model: User,
          as: 'user',
          attributes: ['username', 'avatarUrl', 'nickname'],
          required: true
        }
      ],
      group: ['RatingDetail.userId', 'user.id', 'user.username'],
      order: [[sequelize.fn('COUNT', sequelize.col('RatingDetail.id')), 'DESC']],
      raw: false
    });

    // Get all inactive raters (users who are raters but have no ratings in the date range)
    const inactiveRaters = await User.findAll({
      where: {
        id: {
          [Op.notIn]: activeRaters.map((result: any) => result.userId)
        },
        isRater: true
      },
      attributes: ['id', 'username', 'avatarUrl', 'nickname'],
      order: [['username', 'ASC']] // Sort inactive raters alphabetically
    });

    // Calculate days since selected date
    let daysDiff: number;
    if (selectedEndDate) {
      // If end date is provided, calculate days between start and end date
      daysDiff = Math.ceil((selectedEndDate.getTime() - selectedStartDate.getTime()) / (1000 * 60 * 60 * 24)) + 1;
    } else {
      // If no end date, calculate days from start date to now
      daysDiff = Math.ceil((new Date().getTime() - selectedStartDate.getTime()) / (1000 * 60 * 60 * 24));
    }

    // Get total ratings count for the entire timespan
    const totalRatingsCount = await RatingDetail.count({
      where: dateFilter
    });

    // Calculate overall average ratings per day for the entire timespan
    const overallAverageRatingsPerDay = daysDiff > 0 
      ? totalRatingsCount / daysDiff 
      : 0;

    // Format active raters
    const formattedActiveRaters = activeRaters.map((result: any) => {
      const ratingCount = parseInt(result.dataValues.ratingCount);
      const averagePerDay = daysDiff > 0 ? ratingCount / daysDiff : 0;
      
      return {
        userId: result.userId,
        username: result.user?.username || 'Unknown',
        avatarUrl: result.user?.avatarUrl || '',
        nickname: result.user?.nickname || '',
        ratingCount,
        averagePerDay
      };
    });

    // Format inactive raters
    const formattedInactiveRaters = inactiveRaters.map((rater: any) => ({
      userId: rater.id,
      username: rater.username,
      avatarUrl: rater.avatarUrl,
      nickname: rater.nickname,
      ratingCount: 0,
      averagePerDay: 0
    }));

    // Combine both lists: active raters first, then inactive raters
    const allRaters = [...formattedActiveRaters, ...formattedInactiveRaters];
    
    // Calculate total count for pagination
    const totalCount = allRaters.length;
    
    // Apply pagination to the combined list
    const paginatedRaters = allRaters.slice(offset, offset + limitNum);

    return res.json({
      startDate: selectedStartDate.toISOString(),
      endDate: selectedEndDate ? selectedEndDate.toISOString() : null,
      totalUsers: totalCount,
      totalRatings: totalRatingsCount,
      averageRatingsPerDay: overallAverageRatingsPerDay,
      currentPage: pageNum,
      totalPages: Math.ceil(totalCount / limitNum),
      hasNextPage: pageNum < Math.ceil(totalCount / limitNum),
      hasPrevPage: pageNum > 1,
      ratingsPerUser: paginatedRaters
    });

  } catch (error) {
    logger.error('Error fetching ratings per user:', error);
    return res.status(500).json({error: 'Failed to fetch ratings per user'});
  }
});

export default router;
