import Level from './Level';
import Pass from './Pass';
import Player from './Player';
import Judgement from './Judgement';
import Rating from './Rating';
import RatingDetail from './RatingDetail';
import Difficulty from './Difficulty';
import {PassSubmission, PassSubmissionJudgements, PassSubmissionFlags} from './PassSubmission';
import Reference from './References';
import User from './User';
import OAuthProvider from './OAuthProvider';

export function initializeAssociations() {
  // User associations
  User.belongsTo(Player, {
    foreignKey: 'playerId',
    as: 'player'
  });

  Player.hasOne(User, {
    foreignKey: 'playerId',
    as: 'user'
  });

  User.hasMany(OAuthProvider, {
    foreignKey: 'userId',
    as: 'providers'
  });

  OAuthProvider.belongsTo(User, {
    foreignKey: 'userId',
    as: 'oauthUser'
  });

  // Player has many Passes
  Player.hasMany(Pass, {
    foreignKey: 'playerId',
    as: 'passes',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  // Pass belongs to Player and Level
  Pass.belongsTo(Player, {
    foreignKey: 'playerId',
    as: 'player',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  Pass.belongsTo(Level, {
    foreignKey: 'levelId',
    as: 'level',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  // Pass has one Judgement
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

  // Level has many Passes
  Level.hasMany(Pass, {
    foreignKey: 'levelId',
    as: 'passes',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  Level.hasOne(Rating, {
    foreignKey: 'levelId',
    as: 'rating',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  // Rating belongs to Level
  Rating.belongsTo(Level, {
    foreignKey: 'levelId',
    as: 'level',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  // Rating belongs to Difficulties
  Rating.belongsTo(Difficulty, {
    foreignKey: 'currentDifficultyId',
    as: 'currentDifficulty',
  });

  Rating.belongsTo(Difficulty, {
    foreignKey: 'averageDifficultyId',
    as: 'averageDifficulty',
  });

  // Difficulty has many Ratings
  Difficulty.hasMany(Rating, {
    foreignKey: 'currentDifficultyId',
    as: 'currentRatings',
  });

  Difficulty.hasMany(Rating, {
    foreignKey: 'averageDifficultyId',
    as: 'averageRatings',
  });

  // Rating has many RatingDetails
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

  // Level belongs to Difficulty
  Level.belongsTo(Difficulty, {
    foreignKey: 'diffId',
    as: 'difficulty',
  });

  // Add the direct hasMany relationship
  Difficulty.hasMany(Level, {
    foreignKey: 'diffId',
    as: 'levels',
  });

  Level.belongsTo(Difficulty, {
    foreignKey: 'previousDiffId',
    as: 'previousDifficulty',
  });

  // Add hasMany for previous difficulties too
  Difficulty.hasMany(Level, {
    foreignKey: 'previousDiffId',
    as: 'previousLevels',
  });

  PassSubmission.belongsTo(Player, {
    foreignKey: 'assignedPlayerId',
    as: 'assignedPlayer',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  // Add PassSubmission to Level association
  PassSubmission.belongsTo(Level, {
    foreignKey: 'levelId',
    as: 'level',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  Level.hasMany(PassSubmission, {
    foreignKey: 'levelId',
    as: 'submissions',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  // Add many-to-many relationship between Difficulty and Level through References
  Difficulty.belongsToMany(Level, {
    through: Reference,
    foreignKey: 'difficultyId',
    otherKey: 'levelId',
    as: 'referenceLevels'
  });

  Level.belongsToMany(Difficulty, {
    through: Reference,
    foreignKey: 'levelId',
    otherKey: 'difficultyId',
    as: 'referenceDifficulties'
  });

  Reference.belongsTo(Difficulty, {
    foreignKey: 'difficultyId',
    as: 'difficultyReference',
  });

  Reference.belongsTo(Level, {
    foreignKey: 'levelId',
    as: 'levelReference',
  });

  // Add PassSubmission associations with its related models
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
}