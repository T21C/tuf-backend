import {DataTypes, Model, Optional} from 'sequelize';
import User from '@/models/auth/User.js';
import {getSequelizeForModelGroup} from '@/config/db.js';

const sequelize = getSequelizeForModelGroup('notifications');

export const USER_FOLLOW_TARGET_TYPES = ['player', 'creator'] as const;
export type UserFollowTargetType = (typeof USER_FOLLOW_TARGET_TYPES)[number];

export interface UserFollowAttributes {
  id: number;
  userId: string;
  targetType: UserFollowTargetType;
  targetId: number;
  createdAt: Date;
}

type UserFollowCreationAttributes = Optional<UserFollowAttributes, 'id' | 'createdAt'>;

class UserFollow
  extends Model<UserFollowAttributes, UserFollowCreationAttributes>
  implements UserFollowAttributes
{
  declare id: number;
  declare userId: string;
  declare targetType: UserFollowTargetType;
  declare targetId: number;
  declare createdAt: Date;

  declare user?: User;
}

UserFollow.init(
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
    targetType: {
      type: DataTypes.ENUM(...USER_FOLLOW_TARGET_TYPES),
      allowNull: false,
    },
    targetId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    sequelize,
    tableName: 'user_follows',
    timestamps: false,
    indexes: [
      {
        name: 'user_follows_user_id_target_type_target_id',
        unique: true,
        fields: ['userId', 'targetType', 'targetId'],
      },
      {
        name: 'user_follows_target_type_target_id',
        fields: ['targetType', 'targetId'],
      },
    ],
  },
);

export default UserFollow;
