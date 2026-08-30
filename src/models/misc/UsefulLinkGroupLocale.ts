import {
  Model,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
  ForeignKey,
} from 'sequelize';
import {getSequelizeForModelGroup} from '@/config/db.js';
import type UsefulLinkGroup from './UsefulLinkGroup.js';

const sequelize = getSequelizeForModelGroup('admin');

class UsefulLinkGroupLocale extends Model<
  InferAttributes<UsefulLinkGroupLocale>,
  InferCreationAttributes<UsefulLinkGroupLocale>
> {
  declare id: CreationOptional<number>;
  declare groupId: ForeignKey<UsefulLinkGroup['id']>;
  declare languageCode: string;
  declare name: string;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

UsefulLinkGroupLocale.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
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
    languageCode: {
      type: DataTypes.STRING(8),
      allowNull: false,
    },
    name: {
      type: DataTypes.STRING(64),
      allowNull: false,
    },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'useful_link_group_locales',
    indexes: [
      {
        unique: true,
        fields: ['groupId', 'languageCode'],
        name: 'useful_link_group_locales_group_language_unique',
      },
      {fields: ['languageCode'], name: 'idx_useful_link_group_locales_language'},
    ],
  },
);

export default UsefulLinkGroupLocale;
