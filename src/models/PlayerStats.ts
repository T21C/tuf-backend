import {Model, DataTypes} from 'sequelize';
import sequelize from '../config/db';
import Player from './Player';

class PlayerStats extends Model {
  declare id: number;
  declare playerId: number;
  declare rankedScore: number;
  declare generalScore: number;
  declare ppScore: number;
  declare wfScore: number;
  declare score12k: number;
  declare rankedScoreRank: number;
  declare generalScoreRank: number;
  declare ppScoreRank: number;
  declare wfScoreRank: number;
  declare score12kRank: number;
  declare averageXacc: number;
  declare universalPassCount: number;
  declare worldsFirstCount: number;
  declare lastUpdated: Date;
}

PlayerStats.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    playerId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      unique: true,
      references: {
        model: 'Players',
        key: 'id',
      },
    },
    rankedScore: {
      type: DataTypes.FLOAT,
      allowNull: false,
      defaultValue: 0,
    },
    generalScore: {
      type: DataTypes.FLOAT,
      allowNull: false,
      defaultValue: 0,
    },
    ppScore: {
      type: DataTypes.FLOAT,
      allowNull: false,
      defaultValue: 0,
    },
    wfScore: {
      type: DataTypes.FLOAT,
      allowNull: false,
      defaultValue: 0,
    },
    score12k: {
      type: DataTypes.FLOAT,
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
    score12kRank: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    averageXacc: {
      type: DataTypes.FLOAT,
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
  },
  {
    sequelize,
    modelName: 'PlayerStats',
    tableName: 'player_stats',
    timestamps: true,
  },
);

PlayerStats.belongsTo(Player, {
  foreignKey: 'playerId',
  as: 'player',
});

Player.hasOne(PlayerStats, {
  foreignKey: 'playerId',
  as: 'stats',
});

export default PlayerStats; 