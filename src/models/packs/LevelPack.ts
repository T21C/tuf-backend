import {Model, DataTypes, Optional} from 'sequelize';
import LevelPackItem from './LevelPackItem.js';
import Level from '../levels/Level.js';
import { getSequelizeForModelGroup } from '../../config/db.js';
const sequelize = getSequelizeForModelGroup('packs');

export interface ILevelPack {
  id: number;
  ownerId: string;
  name: string;
  iconUrl: string | null;
  cssFlags: number;
  isPinned: boolean;
  viewMode: number;
  linkCode: string;
  favoritesCount: number;
  levelCount: number;
  createdAt: Date;
  updatedAt: Date;
}

type LevelPackAttributes = ILevelPack;
type LevelPackCreationAttributes = Optional<
  LevelPackAttributes,
  'id' | 'createdAt' | 'updatedAt' | 'linkCode' | 'favoritesCount' | 'levelCount'
>;

class LevelPack
  extends Model<LevelPackAttributes, LevelPackCreationAttributes>
  implements ILevelPack
{
  declare id: number;
  declare ownerId: string;
  declare name: string;
  declare iconUrl: string | null;
  declare cssFlags: number;
  declare isPinned: boolean;
  declare viewMode: number;
  declare linkCode: string;
  declare favoritesCount: number;
  declare levelCount: number;
  declare createdAt: Date;
  declare updatedAt: Date;

  // Virtual fields from associations
  declare packItems?: LevelPackItem[];
  declare levels?: Level[];
}

LevelPack.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    ownerId: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'Discord ID of the pack owner',
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'Name of the level pack',
    },
    iconUrl: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'CDN URL to custom icon for the pack',
    },
    cssFlags: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: 'Bit storage for CSS preset flags and theming options',
    },
    isPinned: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      comment: 'Whether this pack should be shown when no query is provided',
    },
    viewMode: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1,
      comment: 'View mode: 1=public, 2=linkonly, 3=private, 4=forced private (admin override)',
    },
    linkCode: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
      comment: 'Random alphanumeric code for accessing link-only packs',
    },
    favoritesCount: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: 'Number of times this pack has been favorited',
    },
    levelCount: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: 'Number of levels in this pack',
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    sequelize,
    tableName: 'level_packs',
    timestamps: true,
    indexes: [
      {
        fields: ['ownerId'],
      },
      {
        fields: ['name'],
      },
      {
        fields: ['isPinned'],
      },
      {
        fields: ['viewMode'],
      },
      {
        fields: ['createdAt'],
      },
      {
        fields: ['ownerId', 'isPinned'],
      },
      {
        fields: ['favoritesCount'],
      },
      {
        fields: ['levelCount'],
      },
    ],
  }
);

export default LevelPack;
