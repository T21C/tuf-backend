import User from '@/models/auth/User.js';
import Notification from './Notification.js';
import NotificationPreference from './NotificationPreference.js';
import NotificationCategoryPreference from './NotificationCategoryPreference.js';
import UserFollow from './UserFollow.js';
import NotificationUserSettings from './NotificationUserSettings.js';
import PushSubscription from './PushSubscription.js';

export function initializeNotificationAssociations(): void {
  User.hasMany(Notification, {
    foreignKey: 'userId',
    as: 'notifications',
  });
  Notification.belongsTo(User, {
    foreignKey: 'userId',
    as: 'user',
  });
  Notification.belongsTo(User, {
    foreignKey: 'actorId',
    as: 'actor',
  });

  User.hasMany(NotificationPreference, {
    foreignKey: 'userId',
    as: 'notificationPreferences',
  });
  NotificationPreference.belongsTo(User, {
    foreignKey: 'userId',
    as: 'user',
  });

  User.hasMany(NotificationCategoryPreference, {
    foreignKey: 'userId',
    as: 'notificationCategoryPreferences',
  });
  NotificationCategoryPreference.belongsTo(User, {
    foreignKey: 'userId',
    as: 'user',
  });

  User.hasMany(UserFollow, {
    foreignKey: 'userId',
    as: 'follows',
  });
  UserFollow.belongsTo(User, {
    foreignKey: 'userId',
    as: 'user',
  });

  User.hasOne(NotificationUserSettings, {
    foreignKey: 'userId',
    as: 'notificationUserSettings',
  });
  NotificationUserSettings.belongsTo(User, {
    foreignKey: 'userId',
    as: 'user',
  });

  User.hasMany(PushSubscription, {
    foreignKey: 'userId',
    as: 'pushSubscriptions',
  });
  PushSubscription.belongsTo(User, {
    foreignKey: 'userId',
    as: 'user',
  });
}
