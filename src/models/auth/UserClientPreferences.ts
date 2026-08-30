import {DataTypes, Model, Optional} from 'sequelize';
import User from '@/models/auth/User.js';
import {getSequelizeForModelGroup} from '@/config/db.js';

const sequelize = getSequelizeForModelGroup('auth');

export interface UserClientPreferencesAttributes {
  userId: string;
  payload: Record<string, unknown>;
  updatedAt: Date;
}

type UserClientPreferencesCreationAttributes = Optional<
  UserClientPreferencesAttributes,
  'payload' | 'updatedAt'
>;

class UserClientPreferences
  extends Model<UserClientPreferencesAttributes, UserClientPreferencesCreationAttributes>
  implements UserClientPreferencesAttributes
{
  declare userId: string;
  declare payload: Record<string, unknown>;
  declare updatedAt: Date;

  declare user?: User;
}

UserClientPreferences.init(
  {
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
      primaryKey: true,
      references: {model: 'users', key: 'id'},
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    payload: {
      type: DataTypes.JSON,
      allowNull: false,
      defaultValue: {},
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    sequelize,
    tableName: 'user_client_preferences',
    timestamps: false,
  },
);

export default UserClientPreferences;
