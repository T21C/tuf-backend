import {
  Model,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';
import {getSequelizeForModelGroup} from '@/config/db.js';
import type UsefulLinkTag from './UsefulLinkTag.js';
import type UsefulLinkTagAssignment from './UsefulLinkTagAssignment.js';
import type UsefulLinkLocale from './UsefulLinkLocale.js';

const sequelize = getSequelizeForModelGroup('admin');

class UsefulLink extends Model<
  InferAttributes<UsefulLink>,
  InferCreationAttributes<UsefulLink>
> {
  declare id: CreationOptional<number>;
  declare title: string;
  declare url: string;
  declare description: CreationOptional<string | null>;
  declare ownerId: CreationOptional<string | null>;
  declare isCatalog: CreationOptional<boolean>;
  declare sortWeight: CreationOptional<number>;
  declare isPublished: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare tags?: UsefulLinkTag[];
  declare tagAssignments?: UsefulLinkTagAssignment[];
  declare locales?: UsefulLinkLocale[];
}

UsefulLink.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    title: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    url: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    ownerId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    isCatalog: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    sortWeight: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    isPublished: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
  },
  {
    sequelize,
    tableName: 'useful_links',
    indexes: [
      {fields: ['sortWeight'], name: 'idx_useful_links_sort_weight'},
      {fields: ['ownerId'], name: 'idx_useful_links_owner_id'},
      {fields: ['isCatalog'], name: 'idx_useful_links_is_catalog'},
    ],
  },
);

export default UsefulLink;
