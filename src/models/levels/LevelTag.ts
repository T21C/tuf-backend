import {
  Model,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';
import { getSequelizeForModelGroup } from '@/config/db.js';
import type LevelTagGroup from './LevelTagGroup.js';

const sequelize = getSequelizeForModelGroup('levels');

class LevelTag extends Model<
  InferAttributes<LevelTag>,
  InferCreationAttributes<LevelTag>
> {
  declare id: CreationOptional<number>;
  declare name: string;
  declare icon: CreationOptional<string | null>; // Full CDN URL for icon
  declare color: string; // Hex color code (e.g., "#FF5733")
  declare groupId: CreationOptional<number | null>;
  declare sortOrder: CreationOptional<number>; // Sort order for tags display
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare tagGroup?: LevelTagGroup | null;
}

LevelTag.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    icon: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'Full CDN URL for icon (stored as raw link for frontend ease)',
    },
    color: {
      type: DataTypes.STRING(7),
      allowNull: false,
      comment: 'Hex color code (e.g., "#FF5733")',
    },
    groupId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'level_tag_groups',
        key: 'id',
      },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
    },
    sortOrder: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: 'Sort order for tags display',
    },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'level_tags',
    indexes: [
      {
        fields: ['name'],
      },
      {
        fields: ['groupId'],
        name: 'idx_level_tags_group_id',
      },
    ],
  },
);

export default LevelTag;
