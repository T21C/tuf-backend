import {DataTypes, Model, Optional} from 'sequelize';
import User from '@/models/auth/User.js';
import {getSequelizeForModelGroup} from '@/config/db.js';

const sequelize = getSequelizeForModelGroup('notifications');

export interface NotificationUserSettingsAttributes {
  userId: string;
  pushEnabled: boolean;
  updatedAt: Date;
}

type NotificationUserSettingsCreationAttributes = Optional<
  NotificationUserSettingsAttributes,
  'pushEnabled' | 'updatedAt'
>;

class NotificationUserSettings
  extends Model<NotificationUserSettingsAttributes, NotificationUserSettingsCreationAttributes>
  implements NotificationUserSettingsAttributes
{
  declare userId: string;
  declare pushEnabled: boolean;
  declare updatedAt: Date;

  declare user?: User;
}

NotificationUserSettings.init(
  {
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
      primaryKey: true,
      references: {model: 'users', key: 'id'},
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    pushEnabled: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    sequelize,
    tableName: 'notification_user_settings',
    timestamps: false,
  },
);

export default NotificationUserSettings;
