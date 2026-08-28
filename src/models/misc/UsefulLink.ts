import {
  Model,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';
import {getSequelizeForModelGroup} from '@/config/db.js';
import type UsefulLinkLocale from './UsefulLinkLocale.js';
import type UsefulLinkGroup from './UsefulLinkGroup.js';
import type UsefulLinkGroupAssignment from './UsefulLinkGroupAssignment.js';

const sequelize = getSequelizeForModelGroup('admin');

class UsefulLink extends Model<
  InferAttributes<UsefulLink>,
  InferCreationAttributes<UsefulLink>
> {
  declare id: CreationOptional<number>;
  declare title: string;
  declare url: string;
  declare description: CreationOptional<string | null>;
  declare shorthand: CreationOptional<string | null>;
  declare sortWeight: CreationOptional<number>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare locales?: UsefulLinkLocale[];
  declare groups?: UsefulLinkGroup[];
  declare groupAssignments?: UsefulLinkGroupAssignment[];
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
    shorthand: {
      type: DataTypes.STRING(64),
      allowNull: true,
    },
    sortWeight: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
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
    indexes: [{fields: ['sortWeight'], name: 'idx_useful_links_sort_weight'}],
  },
);

export default UsefulLink;
