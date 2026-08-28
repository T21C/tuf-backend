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
import type UsefulLinkTag from './UsefulLinkTag.js';

const sequelize = getSequelizeForModelGroup('admin');

class UsefulLinkTagAssignment extends Model<
  InferAttributes<UsefulLinkTagAssignment>,
  InferCreationAttributes<UsefulLinkTagAssignment>
> {
  declare id: CreationOptional<number>;
  declare linkId: ForeignKey<UsefulLink['id']>;
  declare tagId: ForeignKey<UsefulLinkTag['id']>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare tag?: UsefulLinkTag;
}

UsefulLinkTagAssignment.init(
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
    tagId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'useful_link_tags',
        key: 'id',
      },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'useful_link_tag_assignments',
    indexes: [
      {
        unique: true,
        fields: ['linkId', 'tagId'],
        name: 'useful_link_tag_assignments_unique',
      },
      {fields: ['linkId']},
      {fields: ['tagId']},
    ],
  },
);

export default UsefulLinkTagAssignment;
