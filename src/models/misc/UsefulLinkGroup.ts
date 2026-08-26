import {
  Model,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';
import {getSequelizeForModelGroup} from '@/config/db.js';
import type UsefulLink from './UsefulLink.js';

const sequelize = getSequelizeForModelGroup('admin');

class UsefulLinkGroup extends Model<
  InferAttributes<UsefulLinkGroup>,
  InferCreationAttributes<UsefulLinkGroup>
> {
  declare id: CreationOptional<number>;
  declare name: string;
  declare sortOrder: CreationOptional<number>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare links?: UsefulLink[];
}

UsefulLinkGroup.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING(64),
      allowNull: false,
      unique: true,
    },
    sortOrder: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'useful_link_groups',
    indexes: [
      {
        fields: ['sortOrder'],
        name: 'idx_useful_link_groups_sort_order',
      },
    ],
  },
);

export default UsefulLinkGroup;
