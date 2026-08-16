import {DataTypes, Model} from 'sequelize';
import User from '@/models/auth/User.js';
import {getSequelizeForModelGroup} from '@/config/db.js';

const sequelize = getSequelizeForModelGroup('notifications');

export interface NotificationPreferenceAttributes {
  userId: string;
  type: string;
  inApp: boolean;
  email: boolean;
  discord: boolean;
}

class NotificationPreference
  extends Model<NotificationPreferenceAttributes>
  implements NotificationPreferenceAttributes
{
  declare userId: string;
  declare type: string;
  declare inApp: boolean;
  declare email: boolean;
  declare discord: boolean;

  declare user?: User;
}

NotificationPreference.init(
  {
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
      primaryKey: true,
      references: {model: 'users', key: 'id'},
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    type: {
      type: DataTypes.STRING(64),
      allowNull: false,
      primaryKey: true,
    },
    inApp: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
    },
    email: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
    },
    discord: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
    },
  },
  {
    sequelize,
    tableName: 'notification_preferences',
    timestamps: false,
  },
);

export default NotificationPreference;
