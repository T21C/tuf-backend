import { Model, DataTypes } from 'sequelize';
import sequelize from '../config/db.js';
import Player from './Player.js';

export enum ModifierType {
  RANKED_ADD = 'ranked_add',           // Adds to ranked score
  RANKED_MULTIPLY = 'ranked_multiply', // Multiplies ranked score
  SCORE_COMBINE = 'score_combine',     // Combines all scores into ranked
  PLAYER_SWAP = 'player_swap',        // Swap pfp and name with another player
  OOPS_ALL_MISS = 'oops_all_miss',    // Add 10+ misses to all clears
  BAN_HAMMER = 'ban_hammer',          // Temporary ban
  SUPER_ADMIN = 'super_admin',        // 5 minutes of super admin
  SCORE_FLIP = 'score_flip',          // Flip ranked score numbers
  KING_OF_CASTLE = 'king_of_castle'   // Remove others' clears from a WF
}



class PlayerModifier extends Model {
  declare id: number;
  declare playerId: number;
  declare type: ModifierType;
  declare value: number | null;
  declare expiresAt: Date;
  declare createdAt: Date;

  // Modifier probabilities (in percentage)
  static readonly PROBABILITIES = {
    // Common (40%)
    [ModifierType.RANKED_ADD]: 40,//40.0,      // Common: 40%

    // Low chance (total 43%)
    [ModifierType.RANKED_MULTIPLY]: 25,
    [ModifierType.SCORE_COMBINE]: 5,
    [ModifierType.OOPS_ALL_MISS]: 13,

    // Very low chance (total 12%)
    [ModifierType.SCORE_FLIP]: 6, 
    [ModifierType.KING_OF_CASTLE]: 6,

    // Super low chance (total 5%)
    [ModifierType.PLAYER_SWAP]: 1.0,
    [ModifierType.BAN_HAMMER]: 3.0, 
    [ModifierType.SUPER_ADMIN]: 1.0 
  } 

  // Modifier configurations
  static readonly CONFIGS: Partial<Record<ModifierType, { min: number; max: number }>> = {
    [ModifierType.RANKED_ADD]: {
      min: 100,
      max: 1000
    },
    [ModifierType.RANKED_MULTIPLY]: {
      min: 1.1,
      max: 1.5
    }
  };

  static associate() {
    PlayerModifier.belongsTo(Player, {
      foreignKey: 'playerId',
      as: 'player'
    });
  }
}

PlayerModifier.init({
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  playerId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'players',
      key: 'id'
    }
  },
  type: {
    type: DataTypes.STRING,
    allowNull: false
  },
  value: {
    type: DataTypes.FLOAT,
    allowNull: true
  },
  expiresAt: {
    type: DataTypes.DATE,
    allowNull: false
  },
  createdAt: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW
  }
}, {
  sequelize,
  modelName: 'PlayerModifier',
  tableName: 'player_modifiers',
  timestamps: false
});

export default PlayerModifier; 