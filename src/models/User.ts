import { Model, DataTypes } from 'sequelize';
import sequelize from '../config/db';
import Player from './Player';
import OAuthProvider from './OAuthProvider';

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
  status: 'active' | 'suspended' | 'banned';
  playerId?: number;
  lastLogin?: Date;
  nickname?: string | null;
  avatarId?: string | null;
  avatarUrl?: string | null;
  createdAt: Date;
  updatedAt: Date;
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
  declare status: 'active' | 'suspended' | 'banned';
  declare playerId?: number;
  declare lastLogin?: Date;
  declare nickname?: string | null;
  declare avatarId?: string | null;
  declare avatarUrl?: string | null;
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
      primaryKey: true
    },
    username: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true
    },
    email: {
      type: DataTypes.STRING,
      unique: true,
      allowNull: true,
      validate: {
        isEmail: true
      }
    },
    password: {
      type: DataTypes.STRING,
      allowNull: true
    },
    passwordResetToken: {
      type: DataTypes.STRING,
      allowNull: true
    },
    passwordResetExpires: {
      type: DataTypes.DATE,
      allowNull: true
    },
    isEmailVerified: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },
    isRater: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },
    isSuperAdmin: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },
    status: {
      type: DataTypes.ENUM('active', 'suspended', 'banned'),
      defaultValue: 'active'
    },
    playerId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'players',
        key: 'id'
      }
    },
    lastLogin: {
      type: DataTypes.DATE,
      allowNull: true
    },
    nickname: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: null
    },
    avatarId: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: null
    },
    avatarUrl: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: null
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false
    }
  },
  {
    sequelize,
    tableName: 'users',
    indexes: [
      { unique: true, fields: ['email'] },
      { unique: true, fields: ['username'] },
      { fields: ['playerId'] }
    ]
  }
);

export default User; 