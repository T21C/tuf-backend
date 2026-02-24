import { Router } from 'express';
import Level from '@/models/levels/Level.js';
import { Auth } from '@/server/middleware/auth.js';
import { logger } from '@/server/services/LoggerService.js';
import cdnService from '@/server/services/CdnService.js';
import axios from 'axios';
import Rating from '@/models/levels/Rating.js';
import RatingDetail from '@/models/levels/RatingDetail.js';
import { calculateAverageRating } from '@/misc/utils/data/RatingUtils.js';
import sequelize from '@/config/db.js';
import { safeTransactionRollback } from '@/misc/utils/Utility.js';


const AUTORATER_UUID = process.env.AUTORATER_UUID;
if (!AUTORATER_UUID) {
    throw new Error('AUTORATER_UUID is not set');
}
const router = Router();

router.post('/autorate/:ratingId([0-9]{1,20})', Auth.superAdmin(), async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
    const ratingId = parseInt(req.params.ratingId);
    const rating = await Rating.findByPk(ratingId);

    if (!rating) return res.status(404).json({ error: 'Rating not found' })
    if (!rating.levelId) return res.status(400).json({ error: 'Level ID is required' });

    const level = await Level.findByPk(rating.levelId);
    if (!level || level.isDeleted || level.isHidden) return res.status(404).json({ error: 'Level not found' })

    const levelFile = await cdnService.getLevelAdofai(level) || await fetch("https://api.tuforums.com/v2/database/levels/" + rating.levelId + "/level.adofai").then(res => res.json());
    if (!levelFile) return res.status(404).json({ error: 'No level file available' })

    const requestBody = {
        "Content": levelFile,
        "techMode": false
    }

    const response = await axios.post(`${process.env.OWOSEAN_API_URL}/rate`, requestBody);
    if (response.status !== 200) return res.status(500).json({ error: 'Failed to autorate level', response: response.data })

    const result = response.data.result;
    const ratingRange = (result.range as [string, string]).join('-');
    const comment = "Similar to " + (result.similar_level as [string])[0];


    await RatingDetail.upsert({
        ratingId: ratingId,
        userId: AUTORATER_UUID,
        rating: ratingRange,
        comment: comment,
        isCommunityRating: false,
    })
    

    const details = await RatingDetail.findAll({
      where: {ratingId: ratingId},
      transaction,
    });
    // Calculate new average difficulties for both rater and community ratings
    const averageDifficulty = await calculateAverageRating(details, transaction);
    logger.debug(`[RatingService] averageDifficulty: ${averageDifficulty} for ${rating}`);
    const communityDifficulty = await calculateAverageRating(
      details,
      transaction,
      true,
    );
    await Rating.update(
      {
        averageDifficultyId: averageDifficulty?.id ?? null,
        communityDifficultyId: communityDifficulty?.id ?? null,
      },
      { where: { id: ratingId }, transaction },
    );
    await transaction.commit();

    return res.json({
        response: response.data,
        message: 'Level autorated successfully',
    });
} catch (error: any) {
    if (error.response) {
        return res.status(500).json({ error: 'Failed to autorate level', response: error.response.data });
    }
    await safeTransactionRollback(transaction);
    logger.error('Error autorating level:', error);
    return res.status(500).json({ error: 'Failed to autorate level' });
}
});

export default router;