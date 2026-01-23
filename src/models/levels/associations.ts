import Level from './Level.js';
import Difficulty from './Difficulty.js';
import Rating from './Rating.js';
import RatingDetail from './RatingDetail.js';
import LevelCredit from './LevelCredit.js';
import LevelAlias from './LevelAlias.js';
import Reference from './References.js';
import Team from '../credits/Team.js';
import Pass from '../passes/Pass.js';
import Curation from '../curations/Curation.js';
import { PassSubmission } from '../submissions/PassSubmission.js';
import LevelPackItem from '../packs/LevelPackItem.js';
import LevelPack from '../packs/LevelPack.js';
import LevelTag from './LevelTag.js';
import LevelTagAssignment from './LevelTagAssignment.js';
import Song from '../songs/Song.js';
import Artist from '../artists/Artist.js';
import SongCredit from '../songs/SongCredit.js';

export function initializeLevelsAssociations() {
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

  // Level <-> LevelPackItem associations
  Level.hasMany(LevelPackItem, {
    foreignKey: 'levelId',
    as: 'packItems',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  LevelPackItem.belongsTo(Level, {
    foreignKey: 'levelId',
    as: 'level',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  // Level <-> LevelPack (through LevelPackItem) associations
  Level.belongsToMany(LevelPack, {
    through: LevelPackItem,
    as: 'levelPacks',
    foreignKey: 'levelId',
    otherKey: 'packId',
  });

  LevelPack.belongsToMany(Level, {
    through: LevelPackItem,
    as: 'levels',
    foreignKey: 'packId',
    otherKey: 'levelId',
  });

  // Level <-> Curation associations
  Curation.belongsTo(Level, {
    foreignKey: 'levelId',
    as: 'level',
  });

  // Level <-> LevelTag associations (many-to-many through LevelTagAssignment)
  Level.belongsToMany(LevelTag, {
    through: LevelTagAssignment,
    foreignKey: 'levelId',
    otherKey: 'tagId',
    as: 'tags',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  LevelTag.belongsToMany(Level, {
    through: LevelTagAssignment,
    foreignKey: 'tagId',
    otherKey: 'levelId',
    as: 'levels',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  // LevelTagAssignment associations
  LevelTagAssignment.belongsTo(Level, {
    foreignKey: 'levelId',
    as: 'level',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  LevelTagAssignment.belongsTo(LevelTag, {
    foreignKey: 'tagId',
    as: 'tag',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  Level.hasMany(LevelTagAssignment, {
    foreignKey: 'levelId',
    as: 'tagAssignments',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  LevelTag.hasMany(LevelTagAssignment, {
    foreignKey: 'tagId',
    as: 'levelAssignments',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  // Level <-> Song associations (already defined in songs/associations.ts, but adding here for completeness)
  // Level <-> Artist associations (already defined in artists/associations.ts, but adding here for completeness)
  // Note: Song and Artist associations are initialized in their respective association files
}
