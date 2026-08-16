import User from '@/models/auth/User.js';
import Notification from './Notification.js';
import NotificationPreference from './NotificationPreference.js';

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
}
