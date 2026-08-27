import {
  Model,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';
import { getSequelizeForModelGroup } from '@/config/db.js';
import type LevelTag from './LevelTag.js';

const sequelize = getSequelizeForModelGroup('levels');

class LevelTagGroup extends Model<
  InferAttributes<LevelTagGroup>,
  InferCreationAttributes<LevelTagGroup>
> {
  declare id: CreationOptional<number>;
  declare name: string;
  declare sortOrder: CreationOptional<number>;
  declare wilsonZ: CreationOptional<number | null>;
  declare scoreOn: CreationOptional<number | null>;
  declare scoreOff: CreationOptional<number | null>;
  declare scoringMode: CreationOptional<string | null>;
  declare allowedBands: CreationOptional<string[] | null>;
  declare requireTopPlay: CreationOptional<boolean | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare tags?: LevelTag[];
}

LevelTagGroup.init(
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
    sortOrder: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: 'Sort order for tag groups display',
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
      comment: 'wilson | skillset; null means wilson',
    },
    allowedBands: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: 'PGU bands P/G/U/SPEC; null means all difficulties',
    },
    requireTopPlay: {
      type: DataTypes.BOOLEAN,
      allowNull: true,
      comment: 'Require top play + 1 to vote; null means true',
    },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'level_tag_groups',
    indexes: [
      {
        fields: ['sortOrder'],
        name: 'idx_level_tag_groups_sort_order',
      },
    ],
  },
);

export default LevelTagGroup;
