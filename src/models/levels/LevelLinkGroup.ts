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
  declare shareChart: CreationOptional<boolean>;
  declare shareVfx: CreationOptional<boolean>;
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
    shareChart: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    shareVfx: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
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
