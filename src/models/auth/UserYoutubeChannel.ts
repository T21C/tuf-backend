import {Model, DataTypes, Optional} from 'sequelize';
import User from './User.js';
import {getSequelizeForModelGroup} from '@/config/db.js';

const sequelize = getSequelizeForModelGroup('auth');

interface UserYoutubeChannelAttributes {
  id: number;
  userId: string;
  channelId: string;
  title: string;
  handle: string | null;
  isPrimary: boolean;
  createdAt: Date;
  updatedAt: Date;
}

type UserYoutubeChannelCreationAttributes = Optional<
  UserYoutubeChannelAttributes,
  'id' | 'title' | 'handle' | 'isPrimary'
>;

class UserYoutubeChannel
  extends Model<UserYoutubeChannelAttributes, UserYoutubeChannelCreationAttributes>
  implements UserYoutubeChannelAttributes
{
  declare id: number;
  declare userId: string;
  declare channelId: string;
  declare title: string;
  declare handle: string | null;
  declare isPrimary: boolean;
  declare createdAt: Date;
  declare updatedAt: Date;

  declare user?: User;
}

UserYoutubeChannel.init(
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
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    channelId: {
      type: DataTypes.STRING(64),
      allowNull: false,
    },
    title: {
      type: DataTypes.STRING(255),
      allowNull: false,
      defaultValue: '',
    },
    handle: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    isPrimary: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
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
    tableName: 'user_youtube_channels',
    indexes: [
      {unique: true, fields: ['channelId']},
      {fields: ['userId']},
    ],
  },
);

export default UserYoutubeChannel;
