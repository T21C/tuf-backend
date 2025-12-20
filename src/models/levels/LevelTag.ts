import {
  Model,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';
import { getSequelizeForModelGroup } from '../../config/db.js';
const sequelize = getSequelizeForModelGroup('levels');

class LevelTag extends Model<
  InferAttributes<LevelTag>,
  InferCreationAttributes<LevelTag>
> {
  declare id: CreationOptional<number>;
  declare name: string;
  declare icon: CreationOptional<string | null>; // Full CDN URL for icon
  declare color: string; // Hex color code (e.g., "#FF5733")
  declare group: CreationOptional<string | null>; // Optional group name for organizing tags
  declare sortOrder: CreationOptional<number>; // Sort order for tags display
  declare groupSortOrder: CreationOptional<number>; // Sort order for tag groups display
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
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
    group: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Optional group name for organizing tags',
    },
    sortOrder: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: 'Sort order for tags display',
    },
    groupSortOrder: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: 'Sort order for tag groups display',
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
    ],
  },
);

export default LevelTag;
