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
