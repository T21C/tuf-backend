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
  declare isCommunity: CreationOptional<boolean>;
  declare passWarningEnabled: CreationOptional<boolean>;
  declare description: CreationOptional<string | null>;
  declare wilsonZ: CreationOptional<number | null>;
  declare scoreOn: CreationOptional<number | null>;
  declare scoreOff: CreationOptional<number | null>;
  declare scoringMode: CreationOptional<string | null>;
  declare allowedBands: CreationOptional<string[] | null>;
  declare requireTopPlay: CreationOptional<boolean | null>;
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
    isCommunity: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      comment: 'When true, the public can vote this tag onto levels',
    },
    passWarningEnabled: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
      comment: 'When false, skip this tag in the pass-submit requirement warning modal',
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    wilsonZ: {
      type: DataTypes.DOUBLE,
      allowNull: true,
    },
    scoreOn: {
      type: DataTypes.DOUBLE,
      allowNull: true,
    },
    scoreOff: {
      type: DataTypes.DOUBLE,
      allowNull: true,
    },
    scoringMode: {
      type: DataTypes.STRING(16),
      allowNull: true,
      comment: 'wilson | skillset; null inherits group then wilson',
    },
    allowedBands: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: 'PGU bands P/G/U/SPEC; null inherits group then all',
    },
    requireTopPlay: {
      type: DataTypes.BOOLEAN,
      allowNull: true,
      comment: 'Require top play + 1 to vote; null inherits group, true/false overrides.',
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
