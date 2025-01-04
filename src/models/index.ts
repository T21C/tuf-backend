import {Sequelize} from 'sequelize';
import Level from './Level';
import Pass from './Pass';
import Player from './Player';
import Rating from './Rating';
import RatingDetail from './RatingDetail';
import Judgement from './Judgement';
import LevelSubmission from './LevelSubmission';
import Difficulty from './Difficulty';
import {
  PassSubmission,
  PassSubmissionJudgements,
  PassSubmissionFlags,
} from './PassSubmission';
import sequelize from '../config/db';
import {initializeAssociations} from './associations';
import User from './User';
import OAuthProvider from './OAuthProvider';

// Create db object with models first
export const db = {
  sequelize,
  models: {
    Level,
    Pass,
    Player,
    Rating,
    RatingDetail,
    Judgement,
    LevelSubmission,
    PassSubmission,
    PassSubmissionJudgements,
    PassSubmissionFlags,
    Difficulty,
    User,
    OAuthProvider,
  },
};

// Initialize associations after models are defined
initializeAssociations();

// Define associations
User.hasMany(OAuthProvider, {
  foreignKey: 'userId',
  as: 'oauthProviders'
});

OAuthProvider.belongsTo(User, {
  foreignKey: 'userId'
});

export default db;

// Also export User and OAuthProvider directly for convenience
export { User, OAuthProvider };
