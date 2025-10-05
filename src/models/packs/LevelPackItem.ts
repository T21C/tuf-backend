import {Model, DataTypes, Optional} from 'sequelize';
import sequelize from '../../config/db.js';
import LevelPack from './LevelPack.js';
import Level from '../levels/Level.js';

export interface ILevelPackItem {
  id: number;
  packId: number;
  type: 'folder' | 'level';
  parentId: number | null;
  name: string | null;
  levelId: number | null;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

type LevelPackItemAttributes = ILevelPackItem;
type LevelPackItemCreationAttributes = Optional<
  LevelPackItemAttributes,
  'id' | 'parentId' | 'name' | 'levelId' | 'createdAt' | 'updatedAt'
>;

class LevelPackItem
  extends Model<LevelPackItemAttributes, LevelPackItemCreationAttributes>
  implements ILevelPackItem
{
  declare id: number;
  declare packId: number;
  declare type: 'folder' | 'level';
  declare parentId: number | null;
  declare name: string | null;
  declare levelId: number | null;
  declare sortOrder: number;
  declare createdAt: Date;
  declare updatedAt: Date;

  // Virtual fields from associations
  declare pack?: LevelPack;
  declare referencedLevel?: Level;
  declare parent?: LevelPackItem;
  declare children?: LevelPackItem[];
}

LevelPackItem.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    packId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'level_packs',
        key: 'id',
      },
      onDelete: 'CASCADE',
      comment: 'Reference to the level pack',
    },
    type: {
      type: DataTypes.ENUM('folder', 'level'),
      allowNull: false,
      defaultValue: 'level',
      comment: 'Type of item: folder or level',
    },
    parentId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'level_pack_items',
        key: 'id',
      },
      onDelete: 'CASCADE',
      comment: 'Parent item ID for tree structure within pack',
    },
    name: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Name of the folder (null for level items)',
    },
    levelId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'levels',
        key: 'id',
      },
      onDelete: 'CASCADE',
      comment: 'Reference to the level (null for folder items)',
    },
    sortOrder: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: 'Order within parent',
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
    tableName: 'level_pack_items',
    timestamps: true,
    indexes: [
      {
        fields: ['packId'],
      },
      {
        fields: ['levelId'],
      },
      {
        fields: ['parentId'],
      },
      {
        fields: ['type'],
      },
      {
        fields: ['packId', 'parentId', 'sortOrder'],
        name: 'level_pack_items_pack_parent_sort',
      },
    ],
  }
);

export default LevelPackItem;
