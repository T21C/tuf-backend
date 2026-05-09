import {Model, DataTypes} from 'sequelize';
import Player from '@/models/players/Player.js';
import OAuthProvider from './OAuthProvider.js';
import Creator from '@/models/credits/Creator.js';
import { getSequelizeForModelGroup } from '@/config/db.js';
const sequelize = getSequelizeForModelGroup('auth');

export interface UserAttributes {
  id: string;
  username: string;
  email?: string;
  password?: string;
  passwordResetToken?: string | null;
  passwordResetExpires?: Date | null;
  isEmailVerified: boolean;
  isRater: boolean;
  isSuperAdmin: boolean;
  isRatingBanned: boolean;
  status: 'active' | 'suspended' | 'banned';
  playerId?: number;
  creatorId?: number | null;
  lastLogin?: Date;
  nickname?: string | null;
  avatarId?: string | null;
  avatarUrl?: string | null;
  permissionFlags: bigint | number;
  permissionVersion: number;
  deletionScheduledAt?: Date | null;
  deletionExecuteAt?: Date | null;
  /** When true, scheduled hard-delete also purges the linked creator profile (solo levels removed). */
  deletionIncludeCreator?: boolean;
  deletionSnapshotPermissionFlags?: bigint | number | null;
  /** When set and strictly in the future, TUFStellar subscription benefits apply (entitlement is from this date only). */
  tufStellarSubscriptionExpiresAt?: Date | null;
  /** Provider-side subscription / user reference (e.g. Xsolla) for support and webhooks. */
  tufStellarSubscriptionExternalId?: string | null;
  /** Set when the user (or a webhook) cancelled the recurring subscription; benefits keep until expiresAt. */
  tufStellarSubscriptionCancelledAt?: Date | null;
  /** Persisted billing lifecycle (`billingLifecycleTransition.ts`). */
  tufStellarBillingLifecycleState?:
    | 'inactive'
    | 'active_checkout_pending'
    | 'active_renewing'
    | 'active_cancelling';
  /** True when the uploaded profile image is an animated GIF (CDN also stores JPEG stills for expiry fallback). */
  avatarIsGif?: boolean;
  lastUsernameChange?: Date | null;
  previousUsername?: string | null;
  createdAt: Date;
  updatedAt: Date;
  providers?: OAuthProvider[];
  player?: Player;
  creator?: Creator;
}

class User extends Model<UserAttributes> implements UserAttributes {
  declare id: string;
  declare username: string;
  declare email?: string;
  declare password?: string;
  declare passwordResetToken?: string | null;
  declare passwordResetExpires?: Date | null;
  declare isEmailVerified: boolean;
  declare isRater: boolean;
  declare isSuperAdmin: boolean;
  declare isRatingBanned: boolean;
  declare status: 'active' | 'suspended' | 'banned';
  declare playerId?: number;
  declare creatorId?: number | null;
  declare lastLogin?: Date;
  declare nickname?: string | null;
  declare avatarId?: string | null;
  declare avatarUrl?: string | null;
  declare permissionFlags: bigint | number;
  declare permissionVersion: number;
  declare deletionScheduledAt?: Date | null;
  declare deletionExecuteAt?: Date | null;
  declare deletionIncludeCreator?: boolean;
  declare deletionSnapshotPermissionFlags?: bigint | number | null;
  declare tufStellarSubscriptionExpiresAt?: Date | null;
  declare tufStellarSubscriptionExternalId?: string | null;
  declare tufStellarSubscriptionCancelledAt?: Date | null;
  declare tufStellarBillingLifecycleState?:
    | 'inactive'
    | 'active_checkout_pending'
    | 'active_renewing'
    | 'active_cancelling';
  declare avatarIsGif?: boolean;
  declare lastUsernameChange?: Date | null;
  declare previousUsername?: string | null;
  declare createdAt: Date;
  declare updatedAt: Date;

  // Virtual fields
  declare player?: Player;
  declare creator?: Creator;
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
      unique: true,
      references: {
        model: 'players',
        key: 'id',
      },
    },
    creatorId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      unique: true,
      references: {
        model: 'creators',
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
    permissionFlags: {
      type: DataTypes.BIGINT,
      allowNull: true,
      defaultValue: 0,
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
    deletionScheduledAt: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: null,
    },
    deletionExecuteAt: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: null,
    },
    deletionSnapshotPermissionFlags: {
      type: DataTypes.BIGINT,
      allowNull: true,
      defaultValue: null,
    },
    deletionIncludeCreator: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    tufStellarSubscriptionExpiresAt: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: null,
    },
    tufStellarSubscriptionExternalId: {
      type: DataTypes.STRING(191),
      allowNull: true,
      defaultValue: null,
    },
    tufStellarSubscriptionCancelledAt: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: null,
    },
    tufStellarBillingLifecycleState: {
      type: DataTypes.STRING(32),
      allowNull: false,
      defaultValue: 'inactive',
    },
    avatarIsGif: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
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
