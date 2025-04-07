import Level from './Level.js';
import Pass from './Pass.js';
import Player from './Player.js';
import Judgement from './Judgement.js';
import Rating from './Rating.js';
import RatingDetail from './RatingDetail.js';
import Difficulty from './Difficulty.js';
import {
  PassSubmission,
  PassSubmissionJudgements,
  PassSubmissionFlags,
} from './PassSubmission.js';
import Reference from './References.js';
import User from './User.js';
import OAuthProvider from './OAuthProvider.js';
import Creator from './Creator.js';
import LevelCredit from './LevelCredit.js';
import Team from './Team.js';
import TeamMember from './TeamMember.js';
import LevelAlias from './LevelAlias.js';
import PlayerStats from './PlayerStats.js';
import LevelSubmissionCreatorRequest from './LevelSubmissionCreatorRequest.js';
import LevelSubmissionTeamRequest from './LevelSubmissionTeamRequest.js';
import LevelSubmission from './LevelSubmission.js';
import AnnouncementDirective from './AnnouncementDirective.js';

export function initializeAssociations() {
  // User <-> Player associations
  User.belongsTo(Player, {
    foreignKey: 'playerId',
    as: 'player',
  });

  Player.hasOne(User, {
    foreignKey: 'playerId',
    as: 'user',
  });

  // Player <-> PlayerStats associations
  Player.hasOne(PlayerStats, {
    foreignKey: 'id',
    as: 'stats',
  });

  PlayerStats.belongsTo(Player, {
    foreignKey: 'id',
    as: 'player',
  });

  // User <-> OAuthProvider associations
  User.hasMany(OAuthProvider, {
    foreignKey: 'userId',
    as: 'providers',
  });

  OAuthProvider.belongsTo(User, {
    foreignKey: 'userId',
    as: 'oauthUser',
  });

  // User <-> Creator associations
  User.hasOne(Creator, {
    foreignKey: 'userId',
    as: 'creator',
  });

  Creator.belongsTo(User, {
    foreignKey: 'userId',
    as: 'user',
  });

  // Level <-> Difficulty associations
  Level.belongsTo(Difficulty, {
    foreignKey: 'diffId',
    as: 'difficulty',
  });

  Difficulty.hasMany(Level, {
    foreignKey: 'diffId',
    as: 'levels',
  });

  Level.belongsTo(Difficulty, {
    foreignKey: 'previousDiffId',
    as: 'previousDifficulty',
  });

  Difficulty.hasMany(Level, {
    foreignKey: 'previousDiffId',
    as: 'previousLevels',
  });

  // Level <-> Pass associations
  Level.hasMany(Pass, {
    foreignKey: 'levelId',
    as: 'passes',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  Pass.belongsTo(Level, {
    foreignKey: 'levelId',
    as: 'level',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  // Level <-> Rating associations
  Level.hasMany(Rating, {
    foreignKey: 'levelId',
    as: 'ratings',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  Rating.belongsTo(Level, {
    foreignKey: 'levelId',
    as: 'level',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  // Level <-> Team associations
  Level.belongsTo(Team, {
    foreignKey: 'teamId',
    as: 'teamObject',
  });

  Team.hasMany(Level, {
    foreignKey: 'teamId',
    as: 'levels',
  });

  // Level <-> LevelAlias associations
  Level.hasMany(LevelAlias, {
    foreignKey: 'levelId',
    as: 'aliases',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  LevelAlias.belongsTo(Level, {
    foreignKey: 'levelId',
    as: 'level',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  // Level <-> PassSubmission associations
  Level.hasMany(PassSubmission, {
    foreignKey: 'levelId',
    as: 'submissions',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  PassSubmission.belongsTo(Level, {
    foreignKey: 'levelId',
    as: 'level',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  // Level <-> Creator (through LevelCredit) associations
  Level.belongsToMany(Creator, {
    through: LevelCredit,
    as: 'levelCreators',
    foreignKey: 'levelId',
    otherKey: 'creatorId',
  });

  Creator.belongsToMany(Level, {
    through: LevelCredit,
    as: 'createdLevels',
    foreignKey: 'creatorId',
    otherKey: 'levelId',
  });

  // Level <-> LevelCredit direct associations
  Level.hasMany(LevelCredit, {
    foreignKey: 'levelId',
    as: 'levelCredits',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  LevelCredit.belongsTo(Level, {
    foreignKey: 'levelId',
    as: 'level',
  });

  // Level <-> Difficulty (through Reference) associations
  Level.belongsToMany(Difficulty, {
    through: Reference,
    foreignKey: 'levelId',
    otherKey: 'difficultyId',
    as: 'referenceDifficulties',
  });

  Difficulty.belongsToMany(Level, {
    through: Reference,
    foreignKey: 'difficultyId',
    otherKey: 'levelId',
    as: 'referenceLevels',
  });

  // Reference associations
  Reference.belongsTo(Difficulty, {
    foreignKey: 'difficultyId',
    as: 'difficultyReference',
  });

  Reference.belongsTo(Level, {
    foreignKey: 'levelId',
    as: 'levelReference',
  });

  // Player <-> Pass associations
  Player.hasMany(Pass, {
    foreignKey: 'playerId',
    as: 'passes',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  Pass.belongsTo(Player, {
    foreignKey: 'playerId',
    as: 'player',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  // Pass <-> Judgement associations
  Pass.hasOne(Judgement, {
    foreignKey: 'id',
    as: 'judgements',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  Judgement.belongsTo(Pass, {
    foreignKey: 'id',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  // Rating <-> Difficulty associations
  Rating.belongsTo(Difficulty, {
    foreignKey: 'currentDifficultyId',
    as: 'currentDifficulty',
  });

  Rating.belongsTo(Difficulty, {
    foreignKey: 'averageDifficultyId',
    as: 'averageDifficulty',
  });

  Difficulty.hasMany(Rating, {
    foreignKey: 'currentDifficultyId',
    as: 'currentRatings',
  });

  Difficulty.hasMany(Rating, {
    foreignKey: 'averageDifficultyId',
    as: 'averageRatings',
  });

  Difficulty.hasMany(Rating, {
    foreignKey: 'communityDifficultyId',
    as: 'communityRatings',
  });

  Rating.belongsTo(Difficulty, {
    foreignKey: 'communityDifficultyId',
    as: 'communityDifficulty',
  });

  // Rating <-> RatingDetail associations
  Rating.hasMany(RatingDetail, {
    foreignKey: 'ratingId',
    sourceKey: 'id',
    as: 'details',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  RatingDetail.belongsTo(Rating, {
    foreignKey: 'ratingId',
    targetKey: 'id',
    as: 'parentRating',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  // PassSubmission <-> Player associations
  PassSubmission.belongsTo(Player, {
    foreignKey: 'assignedPlayerId',
    as: 'assignedPlayer',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  // PassSubmission <-> PassSubmissionJudgements associations
  PassSubmission.hasOne(PassSubmissionJudgements, {
    foreignKey: 'passSubmissionId',
    as: 'judgements',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  PassSubmissionJudgements.belongsTo(PassSubmission, {
    foreignKey: 'passSubmissionId',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  // PassSubmission <-> PassSubmissionFlags associations
  PassSubmission.hasOne(PassSubmissionFlags, {
    foreignKey: 'passSubmissionId',
    as: 'flags',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  PassSubmissionFlags.belongsTo(PassSubmission, {
    foreignKey: 'passSubmissionId',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  // Creator <-> LevelCredit associations
  Creator.hasMany(LevelCredit, {
    foreignKey: 'creatorId',
    as: 'credits',
  });

  LevelCredit.belongsTo(Creator, {
    foreignKey: 'creatorId',
    as: 'creator',
  });

  // Team <-> Creator (through TeamMember) associations
  Team.belongsToMany(Creator, {
    through: TeamMember,
    foreignKey: 'teamId',
    otherKey: 'creatorId',
    as: 'members',
  });

  Creator.belongsToMany(Team, {
    through: TeamMember,
    foreignKey: 'creatorId',
    otherKey: 'teamId',
    as: 'teams',
  });

  // LevelSubmission <-> LevelSubmissionCreatorRequest associations
  LevelSubmission.hasMany(LevelSubmissionCreatorRequest, {
    foreignKey: 'submissionId',
    as: 'creatorRequests',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE'
  });

  LevelSubmissionCreatorRequest.belongsTo(LevelSubmission, {
    foreignKey: 'submissionId',
    as: 'submission'
  });

  // LevelSubmissionCreatorRequest <-> Creator associations
  LevelSubmissionCreatorRequest.belongsTo(Creator, {
    foreignKey: 'creatorId',
    as: 'creator'
  });

  // LevelSubmission <-> LevelSubmissionTeamRequest associations
  LevelSubmission.hasOne(LevelSubmissionTeamRequest, {
    foreignKey: 'submissionId',
    as: 'teamRequestData',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE'
  });

  LevelSubmissionTeamRequest.belongsTo(LevelSubmission, {
    foreignKey: 'submissionId',
    as: 'submission'
  });

  // LevelSubmissionTeamRequest <-> Team associations
  LevelSubmissionTeamRequest.belongsTo(Team, {
    foreignKey: 'teamId',
    as: 'team'
  });

  // Difficulty Associations
  Difficulty.hasMany(AnnouncementDirective, {
    foreignKey: 'difficultyId',
    as: 'announcementDirectives',
  });

  AnnouncementDirective.belongsTo(Difficulty, {
    foreignKey: 'difficultyId',
    as: 'difficulty',
  });
}
