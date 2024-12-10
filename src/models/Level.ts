import {Model, DataTypes, Optional} from 'sequelize';
import sequelize from '../config/db';
import {ILevel} from '../types/models';
import Pass from './Pass';

type LevelAttributes = ILevel;
type LevelCreationAttributes = Optional<
  LevelAttributes,
  'id' | 'createdAt' | 'updatedAt'
>;

class Level
  extends Model<LevelAttributes, LevelCreationAttributes>
  implements LevelAttributes
{
  declare id: number;
  declare song: string;
  declare artist: string;
  declare creator: string;
  declare charter: string;
  declare vfxer: string;
  declare team: string;
  declare diff: number;
  declare legacyDiff: number;
  declare pguDiff: string;
  declare pguDiffNum: number;
  declare newDiff: number;
  declare baseScore: number;
  declare baseScoreDiff: string;
  declare isCleared: boolean;
  declare clears: number;
  declare vidLink: string;
  declare dlLink: string;
  declare workshopLink: string;
  declare publicComments: string;
  declare toRate: boolean;
  declare rerateReason: string;
  declare rerateNum: string;
  declare isDeleted: boolean;
  declare createdAt: Date;
  declare updatedAt: Date;

  // Associations
  declare passes?: Pass[];
}

Level.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    song: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    artist: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    creator: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    charter: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    vfxer: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    team: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    diff: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    legacyDiff: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    pguDiff: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    pguDiffNum: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    newDiff: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    baseScore: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    baseScoreDiff: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    isCleared: {
      type: DataTypes.BOOLEAN,
      allowNull: true,
    },
    clears: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    vidLink: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    dlLink: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    workshopLink: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    publicComments: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    toRate: {
      type: DataTypes.BOOLEAN,
      allowNull: true,
    },
    rerateReason: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    rerateNum: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    isDeleted: {
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
  },
  {
    sequelize,
    tableName: 'levels',
    indexes: [
      {fields: [{name: 'song', length: 255}]},
      {fields: [{name: 'artist', length: 255}]},
      {fields: [{name: 'charter', length: 255}]},
      {fields: [{name: 'diff'}]},
    ],
  },
);

export default Level;
