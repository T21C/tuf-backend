import Level from './Level';
import Pass from './Pass';
import Player from './Player';
import Judgement from './Judgement';
import Rating from './Rating';
import RatingDetail from './RatingDetail';

export function initializeAssociations() {
  // Pass associations
  Pass.belongsTo(Level, { 
    foreignKey: 'levelId', 
    as: 'level',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE'
  });
  
  Pass.belongsTo(Player, { 
    foreignKey: 'playerId', 
    as: 'player',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE'
  });
  
  Pass.hasOne(Judgement, { 
    foreignKey: 'passId', 
    as: 'judgements',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE'
  });

  // Level associations
  Level.hasMany(Pass, { 
    foreignKey: 'levelId', 
    as: 'levelPasses',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE'
  });

  Level.hasOne(Rating, {
    foreignKey: 'levelId',
    as: 'rating',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE'
  });

  // Rating associations
  Rating.belongsTo(Level, {
    foreignKey: 'levelId',
    as: 'level',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE'
  });

  Rating.hasMany(RatingDetail, {
    foreignKey: 'ratingId',
    sourceKey: 'id',
    as: 'RatingDetails',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE'
  });

  RatingDetail.belongsTo(Rating, {
    foreignKey: 'ratingId',
    targetKey: 'id',
    as: 'parentRating',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE'
  });

  // Player associations
  Player.hasMany(Pass, { 
    foreignKey: 'playerId', 
    as: 'playerPasses',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE'
  });
} 