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
import Creator from './Creator';
import LevelCredit from './LevelCredit';
import Team from './Team';
import TeamMember from './TeamMember';
import PlayerStats from './PlayerStats';

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
    Creator,
    LevelCredit,
    Team,
    TeamMember,
    PlayerStats,
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
