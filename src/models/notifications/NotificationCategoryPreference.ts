import {DataTypes, Model} from 'sequelize';
import User from '@/models/auth/User.js';
import {getSequelizeForModelGroup} from '@/config/db.js';

const sequelize = getSequelizeForModelGroup('notifications');

export interface NotificationCategoryPreferenceAttributes {
  userId: string;
  category: string;
  inApp: boolean;
}

class NotificationCategoryPreference
  extends Model<NotificationCategoryPreferenceAttributes>
  implements NotificationCategoryPreferenceAttributes
{
  declare userId: string;
  declare category: string;
  declare inApp: boolean;

  declare user?: User;
}

NotificationCategoryPreference.init(
  {
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
      primaryKey: true,
      references: {model: 'users', key: 'id'},
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    category: {
      type: DataTypes.STRING(32),
      allowNull: false,
      primaryKey: true,
    },
    inApp: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
    },
  },
  {
    sequelize,
    tableName: 'notification_category_preferences',
    timestamps: false,
  },
);

export default NotificationCategoryPreference;
