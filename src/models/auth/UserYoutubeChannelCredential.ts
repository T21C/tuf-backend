import {Model, DataTypes, Optional} from 'sequelize';
import {getSequelizeForModelGroup} from '@/config/db.js';

const sequelize = getSequelizeForModelGroup('auth');

interface UserYoutubeChannelCredentialAttributes {
  userYoutubeChannelId: number;
  refreshToken: string;
  createdAt: Date;
  updatedAt: Date;
}

type UserYoutubeChannelCredentialCreationAttributes = Optional<
  UserYoutubeChannelCredentialAttributes,
  'createdAt' | 'updatedAt'
>;

class UserYoutubeChannelCredential
  extends Model<
    UserYoutubeChannelCredentialAttributes,
    UserYoutubeChannelCredentialCreationAttributes
  >
  implements UserYoutubeChannelCredentialAttributes
{
  declare userYoutubeChannelId: number;
  declare refreshToken: string;
  declare createdAt: Date;
  declare updatedAt: Date;
}

UserYoutubeChannelCredential.init(
  {
    userYoutubeChannelId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
      references: {
        model: 'user_youtube_channels',
        key: 'id',
      },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    refreshToken: {
      type: DataTypes.TEXT,
      allowNull: false,
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
    tableName: 'user_youtube_channel_credentials',
  },
);

export default UserYoutubeChannelCredential;
