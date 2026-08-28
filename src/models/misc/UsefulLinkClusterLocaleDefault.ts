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
import type UsefulLinkClusterItem from './UsefulLinkClusterItem.js';

const sequelize = getSequelizeForModelGroup('admin');

class UsefulLinkClusterLocaleDefault extends Model<
  InferAttributes<UsefulLinkClusterLocaleDefault>,
  InferCreationAttributes<UsefulLinkClusterLocaleDefault>
> {
  declare id: CreationOptional<number>;
  declare clusterId: ForeignKey<UsefulLinkCluster['id']>;
  declare languageCode: string;
  declare itemId: ForeignKey<UsefulLinkClusterItem['id']>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare item?: UsefulLinkClusterItem;
}

UsefulLinkClusterLocaleDefault.init(
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
    languageCode: {
      type: DataTypes.STRING(8),
      allowNull: false,
    },
    itemId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'useful_link_cluster_items',
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
    tableName: 'useful_link_cluster_locale_defaults',
    indexes: [
      {
        unique: true,
        fields: ['clusterId', 'languageCode'],
        name: 'useful_link_cluster_locale_defaults_unique',
      },
    ],
  },
);

export default UsefulLinkClusterLocaleDefault;
