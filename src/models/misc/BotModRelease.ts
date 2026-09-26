import {
  Model,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
  ForeignKey,
} from 'sequelize';
import {getSequelizeForModelGroup} from '@/config/db.js';
import type BotMod from './BotMod.js';

const sequelize = getSequelizeForModelGroup('admin');

class BotModRelease extends Model<InferAttributes<BotModRelease>, InferCreationAttributes<BotModRelease>> {
  declare id: CreationOptional<number>;
  declare botId: ForeignKey<BotMod['id']>;
  declare version: string;
  declare parsedDownload: string;
  declare download: CreationOptional<string | null>;
  declare description: CreationOptional<string | null>;
  declare uploadedAt: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

BotModRelease.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    botId: {
      type: DataTypes.STRING(64),
      allowNull: false,
    },
    version: {
      type: DataTypes.STRING(64),
      allowNull: false,
    },
    parsedDownload: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    download: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    uploadedAt: {
      type: DataTypes.DATE,
      allowNull: true,
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
    tableName: 'bot_mod_releases',
    indexes: [
      {unique: true, fields: ['botId', 'version'], name: 'bot_mod_releases_bot_version_unique'},
    ],
  },
);

export default BotModRelease;
