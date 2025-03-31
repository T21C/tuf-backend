import {Model, DataTypes} from 'sequelize';
import sequelize from '../config/db.js';
import Player from './Player.js';
import OAuthProvider from './OAuthProvider.js';

export interface UserAttributes {
  id: string;
  username: string;
  email?: string;
  password?: string;
  passwordResetToken?: string;
  passwordResetExpires?: Date;
  isEmailVerified: boolean;
  isRater: boolean;
  isSuperAdmin: boolean;
  isRatingBanned: boolean;
  status: 'active' | 'suspended' | 'banned';
  playerId?: number;
  lastLogin?: Date;
  nickname?: string | null;
  avatarId?: string | null;
  avatarUrl?: string | null;
  permissionVersion: number;
  lastUsernameChange?: Date | null;
  previousUsername?: string | null;
  createdAt: Date;
  updatedAt: Date;
  providers?: OAuthProvider[];
  player?: Player;
}

class User extends Model<UserAttributes> implements UserAttributes {
  declare id: string;
  declare username: string;
  declare email?: string;
  declare password?: string;
  declare passwordResetToken?: string;
  declare passwordResetExpires?: Date;
  declare isEmailVerified: boolean;
  declare isRater: boolean;
  declare isSuperAdmin: boolean;
  declare isRatingBanned: boolean;
  declare status: 'active' | 'suspended' | 'banned';
  declare playerId?: number;
  declare lastLogin?: Date;
  declare nickname?: string | null;
  declare avatarId?: string | null;
  declare avatarUrl?: string | null;
  declare permissionVersion: number;
  declare lastUsernameChange?: Date | null;
  declare previousUsername?: string | null;
  declare createdAt: Date;
  declare updatedAt: Date;

  // Virtual fields
  declare player?: Player;
  declare providers?: OAuthProvider[];
}

User.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    username: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    email: {
      type: DataTypes.STRING,
      unique: true,
      allowNull: true,
      validate: {
        isEmail: true,
      },
    },
    password: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    passwordResetToken: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    passwordResetExpires: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    isEmailVerified: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    isRater: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    isSuperAdmin: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    isRatingBanned: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    status: {
      type: DataTypes.ENUM('active', 'suspended', 'banned'),
      defaultValue: 'active',
    },
    playerId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'players',
        key: 'id',
      },
    },
    lastLogin: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    nickname: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: null,
    },
    avatarId: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: null,
    },
    avatarUrl: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: null,
    },
    permissionVersion: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1,
    },
    lastUsernameChange: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: null,
    },
    previousUsername: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: null,
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
    tableName: 'users',
    indexes: [
      {unique: true, fields: ['email']},
      {unique: true, fields: ['username']},
      {fields: ['playerId']},
    ],
  },
);

export default User;
