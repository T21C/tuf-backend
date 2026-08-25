import {DataTypes, Model, Optional} from 'sequelize';
import User from '@/models/auth/User.js';
import {getSequelizeForModelGroup} from '@/config/db.js';

const sequelize = getSequelizeForModelGroup('notifications');

export interface PushSubscriptionAttributes {
  id: number;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  expirationTime: Date | null;
  userAgent: string | null;
  locale: string;
  createdAt: Date;
  lastSeenAt: Date;
}

type PushSubscriptionCreationAttributes = Optional<
  PushSubscriptionAttributes,
  'id' | 'expirationTime' | 'userAgent' | 'locale' | 'createdAt' | 'lastSeenAt'
>;

class PushSubscription
  extends Model<PushSubscriptionAttributes, PushSubscriptionCreationAttributes>
  implements PushSubscriptionAttributes
{
  declare id: number;
  declare userId: string;
  declare endpoint: string;
  declare p256dh: string;
  declare auth: string;
  declare expirationTime: Date | null;
  declare userAgent: string | null;
  declare locale: string;
  declare createdAt: Date;
  declare lastSeenAt: Date;

  declare user?: User;
}

PushSubscription.init(
  {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {model: 'users', key: 'id'},
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    endpoint: {
      type: DataTypes.STRING(512),
      allowNull: false,
    },
    p256dh: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    auth: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    expirationTime: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    userAgent: {
      type: DataTypes.STRING(512),
      allowNull: true,
    },
    locale: {
      type: DataTypes.STRING(16),
      allowNull: false,
      defaultValue: 'en',
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    lastSeenAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    sequelize,
    tableName: 'push_subscriptions',
    timestamps: false,
    indexes: [
      {name: 'push_subscriptions_endpoint', unique: true, fields: ['endpoint']},
      {name: 'push_subscriptions_user_id', fields: ['userId']},
    ],
  },
);

export default PushSubscription;
