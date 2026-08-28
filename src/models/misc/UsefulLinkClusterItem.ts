import {
  Model,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
  ForeignKey,
} from 'sequelize';
import {getSequelizeForModelGroup} from '@/config/db.js';
import type UsefulLinkCluster from './UsefulLinkCluster.js';
import type UsefulLink from './UsefulLink.js';

const sequelize = getSequelizeForModelGroup('admin');

class UsefulLinkClusterItem extends Model<
  InferAttributes<UsefulLinkClusterItem>,
  InferCreationAttributes<UsefulLinkClusterItem>
> {
  declare id: CreationOptional<number>;
  declare clusterId: ForeignKey<UsefulLinkCluster['id']>;
  declare linkId: CreationOptional<number | null>;
  declare sortOrder: CreationOptional<number>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare link?: UsefulLink | null;
  declare cluster?: UsefulLinkCluster;
}

UsefulLinkClusterItem.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    clusterId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'useful_link_clusters',
        key: 'id',
      },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    },
    linkId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'useful_links',
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
    tableName: 'useful_link_cluster_items',
    indexes: [
      {
        unique: true,
        fields: ['clusterId', 'linkId'],
        name: 'useful_link_cluster_items_unique',
      },
      {fields: ['clusterId']},
      {fields: ['linkId']},
    ],
  },
);

export default UsefulLinkClusterItem;
