import {Model, DataTypes} from 'sequelize';
import sequelize from '../config/db';
import Player from './Player';

class PlayerStats extends Model {
  public id!: number;
  public playerId!: number;
  public rankedScore!: number;
  public generalScore!: number;
  public ppScore!: number;
  public wfScore!: number;
  public score12k!: number;
  public rankedScoreRank!: number;
  public generalScoreRank!: number;
  public ppScoreRank!: number;
  public wfScoreRank!: number;
  public score12kRank!: number;
  public averageXacc!: number;
  public universalPassCount!: number;
  public worldsFirstCount!: number;
  public lastUpdated!: Date;
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
    tableName: 'PlayerStats',
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