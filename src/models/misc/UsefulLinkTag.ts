import {
  Model,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';
import {getSequelizeForModelGroup} from '@/config/db.js';
import type UsefulLinkTagGroup from './UsefulLinkTagGroup.js';

const sequelize = getSequelizeForModelGroup('admin');

class UsefulLinkTag extends Model<
  InferAttributes<UsefulLinkTag>,
  InferCreationAttributes<UsefulLinkTag>
> {
  declare id: CreationOptional<number>;
  declare name: string;
  declare color: string;
  declare groupId: CreationOptional<number | null>;
  declare sortOrder: CreationOptional<number>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare tagGroup?: UsefulLinkTagGroup | null;
}

UsefulLinkTag.init(
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
    color: {
      type: DataTypes.STRING(7),
      allowNull: false,
    },
    groupId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'useful_link_tag_groups',
        key: 'id',
      },
      onDelete: 'SET NULL',
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
    tableName: 'useful_link_tags',
    indexes: [
      {fields: ['name']},
      {fields: ['groupId'], name: 'idx_useful_link_tags_group_id'},
    ],
  },
);

export default UsefulLinkTag;
