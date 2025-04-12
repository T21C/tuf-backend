import Level from './Level.js';
import Pass from './Pass.js';
import Player from './Player.js';
import Rating from './Rating.js';
import RatingDetail from './RatingDetail.js';
import Judgement from './Judgement.js';
import LevelSubmission from './LevelSubmission.js';
import Difficulty from './Difficulty.js';
import {
  PassSubmission,
  PassSubmissionJudgements,
  PassSubmissionFlags,
} from './PassSubmission.js';
import sequelize from '../config/db.js';
import {initializeAssociations} from './associations.js';
import User from './User.js';
import OAuthProvider from './OAuthProvider.js';
import Creator from './Creator.js';
import LevelCredit from './LevelCredit.js';
import Team from './Team.js';
import TeamMember from './TeamMember.js';
import PlayerStats from './PlayerStats.js';
import UsernameChange from './UsernameChange.js';
import AnnouncementChannel from './AnnouncementChannel.js';
import AnnouncementRole from './AnnouncementRole.js';
import AnnouncementDirective from './AnnouncementDirective.js';
import DirectiveAction from './DirectiveAction.js';
import RateLimit from './RateLimit.js';
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
    UsernameChange,
    AnnouncementChannel,
    AnnouncementRole,
    AnnouncementDirective,
    DirectiveAction,
    RateLimit,
  },
};

// Initialize associations after models are defined
initializeAssociations();

// Define associations
User.hasMany(OAuthProvider, {
  foreignKey: 'userId',
  as: 'oauthProviders',
});

OAuthProvider.belongsTo(User, {
  foreignKey: 'userId',
});

export default db;

// Also export User and OAuthProvider directly for convenience
export {User, OAuthProvider, RateLimit};
