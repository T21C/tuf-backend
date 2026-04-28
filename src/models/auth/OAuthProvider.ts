import {Model, DataTypes, Optional} from 'sequelize';
import User from './User.js';
import { getSequelizeForModelGroup } from '@/config/db.js';
const sequelize = getSequelizeForModelGroup('auth');

interface OAuthProviderAttributes {
  id: number;
  userId: string;
  provider: string;
  providerId: string;
  createdAt: Date;
  updatedAt: Date;
}

type OAuthProviderCreationAttributes = Optional<OAuthProviderAttributes, 'id'>;

class OAuthProvider
  extends Model<OAuthProviderAttributes, OAuthProviderCreationAttributes>
  implements OAuthProviderAttributes
{
  declare id: number;
  declare userId: string;
  declare provider: string;
  declare providerId: string;
  declare createdAt: Date;
  declare updatedAt: Date;

  // Virtual fields
  declare oauthUser?: User;
}

OAuthProvider.init(
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
    },
    provider: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    providerId: {
      type: DataTypes.STRING,
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
    tableName: 'user_oauth_providers',
    indexes: [
      {unique: true, fields: ['provider', 'providerId']},
      {fields: ['userId']},
      {fields: ['provider']},
    ],
  },
);

export default OAuthProvider;
