import {
  Model,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';
import {getSequelizeForModelGroup} from '@/config/db.js';
import type UsefulLinkClusterItem from './UsefulLinkClusterItem.js';
import type UsefulLinkClusterLocaleDefault from './UsefulLinkClusterLocaleDefault.js';

const sequelize = getSequelizeForModelGroup('admin');

class UsefulLinkCluster extends Model<
  InferAttributes<UsefulLinkCluster>,
  InferCreationAttributes<UsefulLinkCluster>
> {
  declare id: CreationOptional<number>;
  declare ownerId: string;
  declare name: string;
  declare description: CreationOptional<string | null>;
  declare iconUrl: CreationOptional<string | null>;
  declare viewMode: CreationOptional<number>;
  declare linkCode: string;
  declare isPinned: CreationOptional<boolean>;
  declare isOfficial: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare items?: UsefulLinkClusterItem[];
  declare localeDefaults?: UsefulLinkClusterLocaleDefault[];
}

UsefulLinkCluster.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    ownerId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    name: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    iconUrl: {
      type: DataTypes.STRING(512),
      allowNull: true,
    },
    viewMode: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 3,
    },
    linkCode: {
      type: DataTypes.STRING(16),
      allowNull: false,
      unique: true,
    },
    isPinned: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    isOfficial: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'useful_link_clusters',
    indexes: [
      {fields: ['ownerId']},
      {fields: ['viewMode']},
      {fields: ['isPinned']},
      {fields: ['isOfficial']},
      {fields: ['createdAt']},
    ],
  },
);

export default UsefulLinkCluster;
