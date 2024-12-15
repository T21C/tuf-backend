import {Model, DataTypes, Optional} from 'sequelize';
import sequelize from '../config/db';
import {ILevel, IPass} from '../interfaces/models';
import Pass from './Pass';
import Difficulty from './Difficulty';

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
  declare diffId: number;
  declare baseScore: number | null;
  declare isCleared: boolean;
  declare clears: number;
  declare vidLink: string;
  declare dlLink: string;
  declare workshopLink: string;
  declare publicComments: string;
  declare toRate: boolean;
  declare rerateReason: string;
  declare rerateNum: string;
  declare toBeChangedDiff: number;
  declare isDeleted: boolean;
  declare createdAt: Date;
  declare updatedAt: Date;

  // Associations
  declare passes?: Pass[];
  declare difficulty?: Difficulty;
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
    diffId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'difficulties',
        key: 'id',
      },
    },
    baseScore: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: null,
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
    toBeChangedDiff: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'difficulties',
        key: 'id',
      },
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
    ],
  },
);

export default Level;
