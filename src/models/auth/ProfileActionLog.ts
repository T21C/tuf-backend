import { Model, DataTypes } from 'sequelize';
import User from './User.js';
import { getSequelizeForModelGroup } from '@/config/db.js';

const sequelize = getSequelizeForModelGroup('auth');

export type ProfileActionType =
  | 'email_change_requested'
  | 'email_change_confirmed'
  | 'email_change_cancelled'
  | 'email_verify_confirmed'
  | 'password_reset_requested'
  | 'password_reset_confirmed'
  /** Signed-in user changed an existing password. */
  | 'password_changed'
  /** Signed-in OAuth-only user added a password for the first time. */
  | 'password_set'
  | 'oauth_link'
  | 'oauth_unlink'
  | 'username_change'
  | 'step_up_granted';

export interface ProfileActionLogAttributes {
  id?: number;
  userId: string;
  action: ProfileActionType | string;
  metadata?: Record<string, unknown> | null;
  ip?: string | null;
  userAgent?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

class ProfileActionLog
  extends Model<ProfileActionLogAttributes>
  implements ProfileActionLogAttributes
{
  declare id: number;
  declare userId: string;
  declare action: string;
  declare metadata: Record<string, unknown> | null;
  declare ip: string | null;
  declare userAgent: string | null;
  declare createdAt: Date;
  declare updatedAt: Date;
  declare user?: User;
}

ProfileActionLog.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: 'users',
        key: 'id',
      },
    },
    action: {
      type: DataTypes.STRING(64),
      allowNull: false,
    },
    metadata: {
      type: DataTypes.JSON,
      allowNull: true,
      defaultValue: null,
    },
    ip: {
      type: DataTypes.STRING(80),
      allowNull: true,
      defaultValue: null,
    },
    userAgent: {
      type: DataTypes.STRING(512),
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
    tableName: 'profile_action_logs',
    indexes: [{ fields: ['userId', 'createdAt'] }, { fields: ['action'] }],
  },
);

ProfileActionLog.belongsTo(User, {
  foreignKey: 'userId',
  as: 'user',
});

export default ProfileActionLog;
