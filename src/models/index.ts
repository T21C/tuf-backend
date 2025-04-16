import Level from './levels/Level.js';
import Pass from './passes/Pass.js';
import Player from './players/Player.js';
import Rating from './levels/Rating.js';
import RatingDetail from './levels/RatingDetail.js';
import Judgement from './passes/Judgement.js';
import LevelSubmission from './submissions/LevelSubmission.js';
import Difficulty from './levels/Difficulty.js';
import {
  PassSubmission,
  PassSubmissionJudgements,
  PassSubmissionFlags,
} from './submissions/PassSubmission.js';
import sequelize from '../config/db.js';
import {initializeAssociations} from './associations.js';
import User from './auth/User.js';
import OAuthProvider from './auth/OAuthProvider.js';
import Creator from './credits/Creator.js';
import LevelCredit from './levels/LevelCredit.js';
import Team from './credits/Team.js';
import TeamMember from './credits/TeamMember.js';
import PlayerStats from './players/PlayerStats.js';
import UsernameChange from './auth/UsernameChange.js';
import AnnouncementChannel from './announcements/AnnouncementChannel.js';
import AnnouncementRole from './announcements/AnnouncementRole.js';
import AnnouncementDirective from './announcements/AnnouncementDirective.js';
import DirectiveAction from './announcements/DirectiveAction.js';
import RateLimit from './auth/RateLimit.js';
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
