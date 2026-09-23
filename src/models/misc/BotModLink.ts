import {
  Model,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
  ForeignKey,
} from 'sequelize';
import {getSequelizeForModelGroup} from '@/config/db.js';
import type Mod from './Mod.js';
import type BotMod from './BotMod.js';

const sequelize = getSequelizeForModelGroup('admin');

class BotModLink extends Model<InferAttributes<BotModLink>, InferCreationAttributes<BotModLink>> {
  declare id: CreationOptional<number>;
  declare botId: ForeignKey<BotMod['id']>;
  declare modId: ForeignKey<Mod['id']>;
  declare enabled: CreationOptional<boolean>;
  declare lastAppliedVersion: CreationOptional<string | null>;
  declare lastAppliedDownloadUrl: CreationOptional<string | null>;
  declare lastSyncAt: CreationOptional<Date | null>;
  declare lastSyncStatus: CreationOptional<string | null>;
  declare lastSyncMessage: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare botMod?: BotMod;
  declare mod?: Mod;
}

BotModLink.init(
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
    modId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    enabled: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    lastAppliedVersion: {
      type: DataTypes.STRING(64),
      allowNull: true,
    },
    lastAppliedDownloadUrl: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    lastSyncAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    lastSyncStatus: {
      type: DataTypes.STRING(32),
      allowNull: true,
    },
    lastSyncMessage: {
      type: DataTypes.TEXT,
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
    tableName: 'bot_mod_links',
    indexes: [
      {unique: true, fields: ['botId'], name: 'bot_mod_links_bot_id_unique'},
      {unique: true, fields: ['modId'], name: 'bot_mod_links_mod_id_unique'},
    ],
  },
);

export default BotModLink;
