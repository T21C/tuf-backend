import {DataTypes, Model, Optional} from 'sequelize';
import User from '@/models/auth/User.js';
import {getSequelizeForModelGroup} from '@/config/db.js';

const sequelize = getSequelizeForModelGroup('notifications');

export interface NotificationAttributes {
  id: number;
  userId: string;
  type: string;
  payload: unknown;
  actorId: string | null;
  entityType: string | null;
  entityId: string | null;
  groupKey: string | null;
  dedupKey: string | null;
  readAt: Date | null;
  seenAt: Date | null;
  createdAt: Date;
}

type NotificationCreationAttributes = Optional<
  NotificationAttributes,
  | 'id'
  | 'actorId'
  | 'entityType'
  | 'entityId'
  | 'groupKey'
  | 'dedupKey'
  | 'readAt'
  | 'seenAt'
  | 'createdAt'
>;

class Notification
  extends Model<NotificationAttributes, NotificationCreationAttributes>
  implements NotificationAttributes
{
  declare id: number;
  declare userId: string;
  declare type: string;
  declare payload: unknown;
  declare actorId: string | null;
  declare entityType: string | null;
  declare entityId: string | null;
  declare groupKey: string | null;
  declare dedupKey: string | null;
  declare readAt: Date | null;
  declare seenAt: Date | null;
  declare createdAt: Date;

  declare user?: User;
  declare actor?: User;
}

Notification.init(
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
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
    type: {
      type: DataTypes.STRING(64),
      allowNull: false,
    },
    payload: {
      type: DataTypes.JSON,
      allowNull: false,
    },
    actorId: {
      type: DataTypes.UUID,
      allowNull: true,
      references: {model: 'users', key: 'id'},
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    },
    entityType: {
      type: DataTypes.STRING(32),
      allowNull: true,
    },
    entityId: {
      type: DataTypes.STRING(64),
      allowNull: true,
    },
    groupKey: {
      type: DataTypes.STRING(128),
      allowNull: true,
    },
    dedupKey: {
      type: DataTypes.STRING(128),
      allowNull: true,
    },
    readAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    seenAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    sequelize,
    tableName: 'notifications',
    timestamps: false,
    indexes: [
      {name: 'notifications_user_id_created_at', fields: ['userId', 'createdAt']},
      {name: 'notifications_user_id_read_at', fields: ['userId', 'readAt']},
      {
        name: 'notifications_user_id_type_dedup_key',
        fields: ['userId', 'type', 'dedupKey'],
        unique: true,
      },
    ],
  },
);

export default Notification;
