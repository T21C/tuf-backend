import {Model, DataTypes} from 'sequelize';
import { now } from 'sequelize/lib/utils';
import { getSequelizeForModelGroup } from '../../config/db.js';
import DiscordGuild from './DiscordGuild.js';
import Difficulty from '../levels/Difficulty.js';
import CurationType from '../curations/CurationType.js';

const sequelize = getSequelizeForModelGroup('discord');

export type DiscordSyncRoleType = 'DIFFICULTY' | 'CURATION';

export interface IDiscordSyncRole {
  id?: number;
  discordGuildId: number;
  roleId: string;
  label: string;
  type: DiscordSyncRoleType;
  minDifficultyId?: number | null;
  curationTypeId?: number | null;
  conflictGroup?: string | null;
  isActive: boolean;
  sortOrder: number;
  createdAt?: Date;
  updatedAt?: Date;
  // Associations
  guild?: DiscordGuild;
  difficulty?: Difficulty;
  curationType?: CurationType;
}

class DiscordSyncRole extends Model<IDiscordSyncRole> implements IDiscordSyncRole {
  declare id?: number;
  declare discordGuildId: number;
  declare roleId: string;
  declare label: string;
  declare type: DiscordSyncRoleType;
  declare minDifficultyId?: number | null;
  declare curationTypeId?: number | null;
  declare conflictGroup?: string | null;
  declare isActive: boolean;
  declare sortOrder: number;
  declare createdAt?: Date;
  declare updatedAt?: Date;
  // Associations
  declare guild?: DiscordGuild;
  declare difficulty?: Difficulty;
  declare curationType?: CurationType;
}

DiscordSyncRole.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
      allowNull: false,
    },
    discordGuildId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'discord_guilds',
        key: 'id',
      },
    },
    roleId: {
      type: DataTypes.STRING(32),
      allowNull: false,
    },
    label: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    type: {
      type: DataTypes.ENUM('DIFFICULTY', 'CURATION'),
      allowNull: false,
    },
    minDifficultyId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'difficulties',
        key: 'id',
      },
    },
    curationTypeId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'curation_types',
        key: 'id',
      },
    },
    conflictGroup: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    sortOrder: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
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
    tableName: 'discord_sync_roles',
    indexes: [
      {
        fields: ['discordGuildId'],
      },
      {
        fields: ['type'],
      },
      {
        fields: ['minDifficultyId'],
      },
      {
        fields: ['curationTypeId'],
      },
      {
        fields: ['isActive'],
      },
      {
        fields: ['conflictGroup'],
      },
      {
        // Unique constraint: one role per guild
        unique: true,
        fields: ['discordGuildId', 'roleId'],
      },
    ],
  },
);

export default DiscordSyncRole;
