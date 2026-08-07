import { Model, DataTypes, Optional } from 'sequelize';
import { getSequelizeForModelGroup } from '@/config/db.js';

const sequelize = getSequelizeForModelGroup('auth');

export interface OAuthAuthorizationCodeAttributes {
  id: string;
  codeHash: string;
  clientId: string;
  userId: string;
  grantId: string;
  redirectUri: string;
  scopeBits: string;
  codeChallenge: string;
  expiresAt: Date;
  consumedAt?: Date | null;
  createdAt: Date;
}

type OAuthAuthorizationCodeCreationAttributes = Optional<
  OAuthAuthorizationCodeAttributes,
  'id' | 'consumedAt' | 'createdAt'
>;

class OAuthAuthorizationCode
  extends Model<OAuthAuthorizationCodeAttributes, OAuthAuthorizationCodeCreationAttributes>
  implements OAuthAuthorizationCodeAttributes
{
  declare id: string;
  declare codeHash: string;
  declare clientId: string;
  declare userId: string;
  declare grantId: string;
  declare redirectUri: string;
  declare scopeBits: string;
  declare codeChallenge: string;
  declare expiresAt: Date;
  declare consumedAt?: Date | null;
  declare createdAt: Date;
}

OAuthAuthorizationCode.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    codeHash: {
      type: DataTypes.STRING(64),
      allowNull: false,
      unique: true,
    },
    clientId: {
      type: DataTypes.STRING(64),
      allowNull: false,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    grantId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    redirectUri: {
      type: DataTypes.STRING(1024),
      allowNull: false,
    },
    scopeBits: {
      type: DataTypes.STRING(64),
      allowNull: false,
    },
    codeChallenge: {
      type: DataTypes.STRING(128),
      allowNull: false,
    },
    expiresAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    consumedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
  },
  {
    sequelize,
    tableName: 'oauth_authorization_codes',
    updatedAt: false,
    indexes: [
      { name: 'oauth_authorization_codes_code_hash', fields: ['codeHash'], unique: true },
    ],
  },
);

export default OAuthAuthorizationCode;
