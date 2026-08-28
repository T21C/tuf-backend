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

const sequelize = getSequelizeForModelGroup('admin');

class UsefulLinkLocale extends Model<
  InferAttributes<UsefulLinkLocale>,
  InferCreationAttributes<UsefulLinkLocale>
> {
  declare id: CreationOptional<number>;
  declare linkId: ForeignKey<UsefulLink['id']>;
  declare languageCode: string;
  declare title: string;
  declare url: string;
  declare description: CreationOptional<string | null>;
  declare shorthand: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

UsefulLinkLocale.init(
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
    languageCode: {
      type: DataTypes.STRING(8),
      allowNull: false,
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
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'useful_link_locales',
    indexes: [
      {
        unique: true,
        fields: ['linkId', 'languageCode'],
        name: 'useful_link_locales_link_language_unique',
      },
      {fields: ['languageCode'], name: 'idx_useful_link_locales_language'},
    ],
  },
);

export default UsefulLinkLocale;
