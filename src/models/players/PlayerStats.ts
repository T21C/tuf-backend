import {Model, DataTypes} from 'sequelize';
import sequelize from '../../config/db.js';
import Player from './Player.js';
import Difficulty from '../levels/Difficulty.js';

class PlayerStats extends Model {
  declare id: number;
  declare rankedScore: number;
  declare generalScore: number;
  declare ppScore: number;
  declare wfScore: number;
  declare score12K: number;
  declare rankedScoreRank: number;
  declare generalScoreRank: number;
  declare ppScoreRank: number;
  declare wfScoreRank: number;
  declare score12KRank: number;
  declare averageXacc: number;
  declare universalPassCount: number;
  declare worldsFirstCount: number;
  declare lastUpdated?: Date;
  declare createdAt?: Date;
  declare updatedAt?: Date;
  declare topDiffId: number;
  declare top12kDiffId: number;

  // Virtual fields from associations
  declare player?: Player;
  declare topDiff?: Difficulty;
  declare top12kDiff?: Difficulty;
}

PlayerStats.init(
  {
    id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
      references: {
        model: 'players',
        key: 'id',
      },
    },
    topDiffId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    top12kDiffId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    rankedScore: {
      type: DataTypes.DOUBLE,
      allowNull: false,
      defaultValue: 0,
    },
    generalScore: {
      type: DataTypes.DOUBLE,
      allowNull: false,
      defaultValue: 0,
    },
    ppScore: {
      type: DataTypes.DOUBLE,
      allowNull: false,
      defaultValue: 0,
    },
    wfScore: {
      type: DataTypes.DOUBLE,
      allowNull: false,
      defaultValue: 0,
    },
    score12K: {
      type: DataTypes.DOUBLE,
      allowNull: false,
      defaultValue: 0,
    },
    rankedScoreRank: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    generalScoreRank: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    ppScoreRank: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    wfScoreRank: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    score12KRank: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    averageXacc: {
      type: DataTypes.DOUBLE,
      allowNull: false,
      defaultValue: 0,
    },
    universalPassCount: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    worldsFirstCount: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    lastUpdated: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
  },
  {
    sequelize,
    modelName: 'PlayerStats',
    tableName: 'player_stats',
    timestamps: true,
  },
);

export default PlayerStats;
