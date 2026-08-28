import {
  Model,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';
import {getSequelizeForModelGroup} from '@/config/db.js';
import type UsefulLinkTag from './UsefulLinkTag.js';

const sequelize = getSequelizeForModelGroup('admin');

class UsefulLinkTagGroup extends Model<
  InferAttributes<UsefulLinkTagGroup>,
  InferCreationAttributes<UsefulLinkTagGroup>
> {
  declare id: CreationOptional<number>;
  declare name: string;
  declare sortOrder: CreationOptional<number>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare tags?: UsefulLinkTag[];
}

UsefulLinkTagGroup.init(
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
    tableName: 'useful_link_tag_groups',
    indexes: [
      {
        fields: ['sortOrder'],
        name: 'idx_useful_link_tag_groups_sort_order',
      },
    ],
  },
);

export default UsefulLinkTagGroup;
