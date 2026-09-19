import {Model, DataTypes, Optional} from 'sequelize';
import LevelPack from './LevelPack.js';
import Level from '@/models/levels/Level.js';
import { getSequelizeForModelGroup } from '@/config/db.js';
const sequelize = getSequelizeForModelGroup('packs');

export interface ILevelPackItem {
  id: number;
  packId: number;
  type: 'folder' | 'level' | 'note';
  parentId: number; // 0 = root level
  name: string | null;
  description: string | null;
  levelId: number | null;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

type LevelPackItemAttributes = ILevelPackItem;
type LevelPackItemCreationAttributes = Optional<
  LevelPackItemAttributes,
  'id' | 'parentId' | 'name' | 'description' | 'levelId' | 'createdAt' | 'updatedAt'
>;

class LevelPackItem
  extends Model<LevelPackItemAttributes, LevelPackItemCreationAttributes>
  implements ILevelPackItem
{
  declare id: number;
  declare packId: number;
  declare type: 'folder' | 'level' | 'note';
  declare parentId: number; // 0 = root level
  declare name: string | null;
  declare description: string | null;
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
      type: DataTypes.ENUM('folder', 'level', 'note'),
      allowNull: false,
      defaultValue: 'level',
      comment: 'Type of item: folder, level, or note',
    },
    parentId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: 'Parent item ID for tree structure within pack (0 = root level)',
    },
    name: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Folder name or note title (null for level items)',
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'Website-only folder description or note body (null for level items)',
    },
    levelId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'levels',
        key: 'id',
      },
      onDelete: 'CASCADE',
      comment: 'Reference to the level (null for folder and note items)',
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
      {
        unique: true,
        fields: ['packId', 'parentId', 'levelId'],
        name: 'level_pack_items_pack_parent_level_unique',
      },
    ],
  }
);

export default LevelPackItem;
