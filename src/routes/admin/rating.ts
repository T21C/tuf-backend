import express, {Request, Response, Router} from 'express';
import { RaterService } from '../../services/RaterService';
import { Auth } from '../../middleware/auth';
import Rating from '../../models/Rating';
import RatingDetail from '../../models/RatingDetail';
import Level from '../../models/Level';
import {calculateAverageRating} from '../../utils/ratingUtils';
import {IUser} from '../../interfaces/express/index';
import {getIO} from '../../utils/socket';
import sequelize from '../../config/db';
import Difficulty from '../../models/Difficulty';

const router: Router = express.Router();

router.get('/raters', Auth.rater(), async (req: Request, res: Response) => {
  try {
    const raters = await RaterService.getAll();
    const raterNames = raters.map(rater => rater.name);
    res.json(raterNames);
  } catch (error) {
    console.error('Failed to fetch raters:', error);
    res.status(500).json({ error: 'Failed to fetch raters' });
  }
});

router.get('/', Auth.rater(), async (req: Request, res: Response) => {
  try {
    const ratings = await Rating.findAll({
      include: [
        {
          model: RatingDetail,
          as: 'details',
          attributes: ['username', 'rating', 'comment'],
        },
        {
          model: Level,
          as: 'level',
          attributes: [
            'id',
            'song',
            'artist',
            'creator',
            'charter',
            'vfxer',
            'team',
            'diffId',
            'baseScore',
            'isCleared',
            'clears',
            'videoLink',
            'dlLink',
            'workshopLink',
            'publicComments',
            'toRate',
            'rerateReason',
            'rerateNum',
          ],
          include: [
            {
              model: Difficulty,
              as: 'difficulty',
              attributes: ['id', 'name', 'type', 'icon', 'baseScore', 'legacy'],
            },
          ],
        },
      ],
      order: [['levelId', 'ASC']],
    });
    return res.json(ratings);
  } catch (error) {
    console.error('Error fetching rating list:', error);
    return res.status(500).json({error: 'Internal Server Error'});
  }
});

router.put('/', Auth.rater(), async (req: Request, res: Response) => {
  try {
    const userInfo = req.user as IUser;
    const updates = req.body.updates;
    if (!updates || !Array.isArray(updates)) {
      return res.status(400).json({error: 'Updates array is required'});
    }

    const transaction = await sequelize.transaction();
    const updatedRatings = [];

    try {
      // Process each update
      for (const update of updates) {
        if (!update.id) {
          console.error('Missing id in update:', update);
          continue;
        }

        // Find existing rating
        let rating = await Rating.findOne({
          where: {id: update.id},
          transaction,
        });

        if (!rating) {
          // Create new rating if it doesn't exist
          rating = await Rating.create(
            {
              id: update.id,
              levelId: 0,
              currentDiff: '0',
              lowDiff: false,
              requesterFR: '',
              average: '',
            },
            {transaction},
          );
        }

        // Find existing rating detail
        const existingDetail = await RatingDetail.findOne({
          where: {
            ratingId: rating.id,
            username: userInfo.username,
          },
          transaction,
        });

        if (existingDetail) {
          // Update only rating and comment
          await existingDetail.update(
            {
              rating: update.rating,
              comment: update.comment || '',
            },
            {transaction},
          );
        } else {
          // Create new rating detail
          await RatingDetail.create(
            {
              ratingId: rating.id,
              username: userInfo.username,
              rating: update.rating,
              comment: update.comment || '',
            },
            {transaction},
          );
        }

        // Get all rating details for this rating
        const ratingDetails = await RatingDetail.findAll({
          where: {ratingId: rating.id},
          transaction,
        });

        // Calculate new average using the rating details
        const averageRating = calculateAverageRating(ratingDetails);

        // Update only the average in the main rating record
        await rating.update({average: averageRating || ''}, {transaction});

        // Get updated rating with details
        const updatedRating = await Rating.findByPk(rating.id, {
          include: [
            {
              model: RatingDetail,
              as: 'details',
              attributes: ['username', 'rating', 'comment'],
            },
            {
              model: Level,
              as: 'level',
              attributes: [
                'id',
                'song',
                'artist',
                'creator',
                'charter',
                'vfxer',
                'team',
                'baseScore',
                'isCleared',
                'clears',
                'videoLink',
                'dlLink',
                'workshopLink',
                'publicComments',
                'toRate',
                'rerateReason',
                'rerateNum',
              ],
              include: [
                {
                  model: Difficulty,
                  as: 'difficulty',
                  attributes: [
                    'id',
                    'name',
                    'type',
                    'icon',
                    'baseScore',
                    'legacy',
                  ],
                },
              ],
            },
          ],
          transaction,
        });

        if (updatedRating) {
          updatedRatings.push(updatedRating);
        }
      }

      await transaction.commit();

      // Emit the event using the socket utility
      const io = getIO();
      io.emit('ratingsUpdated');

      return res.json({
        success: true,
        message: `Ratings updated successfully by ${userInfo.username}`,
        ratings: updatedRatings,
      });
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  } catch (error) {
    console.error('Error updating ratings:', error);
    return res.status(500).json({error: 'Internal Server Error'});
  }
});

router.delete('/', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    const {id} = req.body;
    if (!id) {
      return res.status(400).json({error: 'Id is required'});
    }

    const rating = await Rating.findOne({where: {id}});
    if (!rating) {
      return res.status(404).json({error: 'Rating not found'});
    }

    // Delete rating details first due to foreign key constraint
    await RatingDetail.destroy({where: {ratingId: rating.id}});
    // Then delete the main rating
    await rating.destroy();

    return res.json({success: true});
  } catch (error) {
    console.error('Error deleting rating:', error);
    return res.status(500).json({error: 'Internal Server Error'});
  }
});

export default router;
