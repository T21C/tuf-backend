import {Model, DataTypes} from 'sequelize';
import { now } from 'sequelize/lib/utils';
import { getSequelizeForModelGroup } from '../../config/db.js';

const sequelize = getSequelizeForModelGroup('discord');

export interface IDiscordGuild {
  id?: number;
  guildId: string;
  name: string;
  botToken: string;
  isActive: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

class DiscordGuild extends Model<IDiscordGuild> implements IDiscordGuild {
  declare id?: number;
  declare guildId: string;
  declare name: string;
  declare botToken: string;
  declare isActive: boolean;
  declare createdAt?: Date;
  declare updatedAt?: Date;
}

DiscordGuild.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
      allowNull: false,
    },
    guildId: {
      type: DataTypes.STRING(32),
      allowNull: false,
      unique: true,
    },
    name: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    botToken: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: now
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: now
    },
  },
  {
    sequelize,
    tableName: 'discord_guilds',
    indexes: [
      {
        unique: true,
        fields: ['guildId'],
      },
      {
        fields: ['isActive'],
      },
    ],
  },
);

// Override toJSON to ensure botToken is never exposed in API responses
DiscordGuild.prototype.toJSON = function() {
  const values = this.get();
  // Use getDataValue to access the raw token value (only accessible internally)
  const hasToken = !!this.getDataValue('botToken');
  // Create new object without exposing the actual token
  const { botToken: _botToken, ...safeValues } = values as any;
  return {
    ...safeValues,
    botToken: '••••••••',
    hasToken,
  };
};

export default DiscordGuild;
