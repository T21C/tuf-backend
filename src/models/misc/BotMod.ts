import {
  Model,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';
import {getSequelizeForModelGroup} from '@/config/db.js';
import type BotModLink from './BotModLink.js';

const sequelize = getSequelizeForModelGroup('admin');

class BotMod extends Model<InferAttributes<BotMod>, InferCreationAttributes<BotMod>> {
  declare id: string;
  declare sourceMongoId: CreationOptional<string | null>;
  declare name: string;
  declare version: CreationOptional<string | null>;
  declare parsedDownload: CreationOptional<string | null>;
  declare download: CreationOptional<string | null>;
  declare description: CreationOptional<string | null>;
  declare cachedUsername: string;
  declare creatorDiscordId: string;
  declare uploadedAt: CreationOptional<Date | null>;
  declare ignoreUpdate: CreationOptional<boolean>;
  declare hideFromSearch: CreationOptional<boolean>;
  declare lastSeenAt: Date;
  declare missingSince: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare link?: BotModLink | null;
}

BotMod.init(
  {
    id: {
      type: DataTypes.STRING(64),
      primaryKey: true,
      allowNull: false,
    },
    sourceMongoId: {
      type: DataTypes.STRING(32),
      allowNull: true,
    },
    name: {
      type: DataTypes.STRING(512),
      allowNull: false,
    },
    version: {
      type: DataTypes.STRING(64),
      allowNull: true,
    },
    parsedDownload: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    download: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    cachedUsername: {
      type: DataTypes.STRING(64),
      allowNull: false,
    },
    creatorDiscordId: {
      type: DataTypes.STRING(32),
      allowNull: false,
    },
    uploadedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    ignoreUpdate: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    hideFromSearch: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    lastSeenAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    missingSince: {
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
    tableName: 'bot_mods',
    indexes: [{fields: ['missingSince'], name: 'idx_bot_mods_missing_since'}],
  },
);

export default BotMod;
