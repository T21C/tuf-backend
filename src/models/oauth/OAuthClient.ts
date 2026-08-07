import { Model, DataTypes, Optional } from 'sequelize';
import { getSequelizeForModelGroup } from '@/config/db.js';

const sequelize = getSequelizeForModelGroup('auth');

export type OAuthClientStatus = 'active' | 'frozen';

export interface OAuthClientAttributes {
  id: string;
  clientId: string;
  ownerUserId: string;
  name: string;
  description?: string | null;
  homepageUrl?: string | null;
  privacyUrl?: string | null;
  iconUrl?: string | null;
  redirectUris: string[];
  allowedScopes: string;
  singleGrant: boolean;
  verified: boolean;
  status: OAuthClientStatus;
  createdAt: Date;
  updatedAt: Date;
}

type OAuthClientCreationAttributes = Optional<
  OAuthClientAttributes,
  | 'id'
  | 'description'
  | 'homepageUrl'
  | 'privacyUrl'
  | 'iconUrl'
  | 'singleGrant'
  | 'verified'
  | 'status'
  | 'createdAt'
  | 'updatedAt'
>;

class OAuthClient
  extends Model<OAuthClientAttributes, OAuthClientCreationAttributes>
  implements OAuthClientAttributes
{
  declare id: string;
  declare clientId: string;
  declare ownerUserId: string;
  declare name: string;
  declare description?: string | null;
  declare homepageUrl?: string | null;
  declare privacyUrl?: string | null;
  declare iconUrl?: string | null;
  declare redirectUris: string[];
  declare allowedScopes: string;
  declare singleGrant: boolean;
  declare verified: boolean;
  declare status: OAuthClientStatus;
  declare createdAt: Date;
  declare updatedAt: Date;
}

OAuthClient.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    clientId: {
      type: DataTypes.STRING(64),
      allowNull: false,
      unique: true,
    },
    ownerUserId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    name: {
      type: DataTypes.STRING(64),
      allowNull: false,
    },
    description: {
      type: DataTypes.STRING(512),
      allowNull: true,
    },
    homepageUrl: {
      type: DataTypes.STRING(512),
      allowNull: true,
    },
    privacyUrl: {
      type: DataTypes.STRING(512),
      allowNull: true,
    },
    iconUrl: {
      type: DataTypes.STRING(512),
      allowNull: true,
    },
    redirectUris: {
      type: DataTypes.JSON,
      allowNull: false,
    },
    allowedScopes: {
      type: DataTypes.STRING(64),
      allowNull: false,
      defaultValue: '0',
    },
    singleGrant: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    verified: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    status: {
      type: DataTypes.ENUM('active', 'frozen'),
      allowNull: false,
      defaultValue: 'active',
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
    tableName: 'oauth_clients',
    indexes: [
      { name: 'oauth_clients_client_id', fields: ['clientId'], unique: true },
      { name: 'oauth_clients_owner_user_id', fields: ['ownerUserId'] },
    ],
  },
);

export default OAuthClient;
