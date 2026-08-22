import {
  Model,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';
import { getSequelizeForModelGroup } from '@/config/db.js';
import type LevelLinkMember from './LevelLinkMember.js';

const sequelize = getSequelizeForModelGroup('levels');

class LevelLinkGroup extends Model<
  InferAttributes<LevelLinkGroup>,
  InferCreationAttributes<LevelLinkGroup>
> {
  declare id: CreationOptional<number>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare members?: LevelLinkMember[];
}

LevelLinkGroup.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'level_link_groups',
  },
);

export default LevelLinkGroup;
