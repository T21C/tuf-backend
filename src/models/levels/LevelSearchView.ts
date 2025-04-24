import { Model, DataTypes } from 'sequelize';
import sequelize from '../../config/db.js';

/**
 * Model representing the level_search_view database view
 * This view contains all one-to-one fields used for searching levels
 */
class LevelSearchView extends Model {
  // These are just type declarations for TypeScript
  declare id: number;
  declare song: string;
  declare artist: string;
  declare charter: string;
  declare team: string;
  declare teamId: number | null;
  declare diffId: number;
  declare baseScore: number;
  declare clears: number;
  declare ratingAccuracy: number;
  declare likes: number;
  declare isDeleted: boolean;
  declare isHidden: boolean;
  declare isAnnounced: boolean;
  declare toRate: boolean;
  declare createdAt: Date;
  declare updatedAt: Date;
  declare sortOrder: number;
  declare type: string;
  declare difficultyName: string;
  declare difficultyColor: string;
  declare teamName: string | null;
}

LevelSearchView.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    song: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    artist: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    charter: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    team: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    teamId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    diffId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    baseScore: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    clears: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    likes: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    ratingAccuracy: {
      type: DataTypes.DOUBLE,
      allowNull: false,
      defaultValue: 0,
    },
    isDeleted: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    isHidden: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    isAnnounced: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    toRate: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    sortOrder: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    type: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    difficultyName: {
      type: DataTypes.STRING,
      allowNull: true,
      field: 'difficultyName',
    },
    difficultyColor: {
      type: DataTypes.STRING,
      allowNull: true,
      field: 'difficultyColor',
    },
    teamName: {
      type: DataTypes.STRING,
      allowNull: true,
      field: 'teamName',
    },
  },
  {
    sequelize,
    modelName: 'LevelSearchView',
    tableName: 'level_search_view',
    timestamps: false, // Views don't have timestamps
    freezeTableName: true,
  }
);

export default LevelSearchView;
