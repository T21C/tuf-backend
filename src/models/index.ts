import { Sequelize } from 'sequelize';
import Level from './Level';
import Pass from './Pass';
import Player from './Player';
import Rating from './Rating';
import RatingDetail from './RatingDetail';
import Judgement from './Judgement';
import RerateSubmission from './RerateSubmission';
import ChartSubmission from './ChartSubmission';
import { PassSubmission, PassSubmissionJudgements, PassSubmissionFlags } from './PassSubmission';
import sequelize from '../config/db';

// Update the relationship definitions
Rating.hasMany(RatingDetail, {
  foreignKey: 'ratingId',
  sourceKey: 'levelId'  // Changed from default 'id'
});

RatingDetail.belongsTo(Rating, {
  foreignKey: 'ratingId',
  targetKey: 'levelId'  // Changed from default 'id'
});

// Export as a named export
export const db = {
  sequelize,
  models: {
    Level,
    Pass,
    Player,
    Rating,
    RatingDetail,
    Judgement,
    RerateSubmission,
    ChartSubmission,
    PassSubmission,
    PassSubmissionJudgements,
    PassSubmissionFlags
  }
};

// Also provide a default export if needed
export default db; 