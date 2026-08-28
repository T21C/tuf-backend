import {
  Model,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
  ForeignKey,
} from 'sequelize';
import {getSequelizeForModelGroup} from '@/config/db.js';
import type UsefulLink from './UsefulLink.js';
import type UsefulLinkGroup from './UsefulLinkGroup.js';

const sequelize = getSequelizeForModelGroup('admin');

class UsefulLinkGroupAssignment extends Model<
  InferAttributes<UsefulLinkGroupAssignment>,
  InferCreationAttributes<UsefulLinkGroupAssignment>
> {
  declare id: CreationOptional<number>;
  declare linkId: ForeignKey<UsefulLink['id']>;
  declare groupId: ForeignKey<UsefulLinkGroup['id']>;
  declare sortOrder: CreationOptional<number>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare link?: UsefulLink;
  declare group?: UsefulLinkGroup;
}

UsefulLinkGroupAssignment.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    linkId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'useful_links',
        key: 'id',
      },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    },
    groupId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'useful_link_groups',
        key: 'id',
      },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
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
    tableName: 'useful_link_group_assignments',
    indexes: [
      {
        unique: true,
        fields: ['linkId', 'groupId'],
        name: 'useful_link_group_assignments_unique',
      },
      {fields: ['groupId'], name: 'idx_useful_link_group_assignments_group_id'},
      {fields: ['linkId'], name: 'idx_useful_link_group_assignments_link_id'},
    ],
  },
);

export default UsefulLinkGroupAssignment;
