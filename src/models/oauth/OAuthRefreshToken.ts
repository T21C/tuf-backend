import { Model, DataTypes, Optional } from 'sequelize';
import { getSequelizeForModelGroup } from '@/config/db.js';

const sequelize = getSequelizeForModelGroup('auth');

export interface OAuthRefreshTokenAttributes {
  id: string;
  grantId: string;
  tokenHash: string;
  userAgent?: string | null;
  ip?: string | null;
  expiresAt: Date;
  replacedBy?: string | null;
  revokedAt?: Date | null;
  createdAt: Date;
}

type OAuthRefreshTokenCreationAttributes = Optional<
  OAuthRefreshTokenAttributes,
  'id' | 'userAgent' | 'ip' | 'replacedBy' | 'revokedAt' | 'createdAt'
>;

class OAuthRefreshToken
  extends Model<OAuthRefreshTokenAttributes, OAuthRefreshTokenCreationAttributes>
  implements OAuthRefreshTokenAttributes
{
  declare id: string;
  declare grantId: string;
  declare tokenHash: string;
  declare userAgent?: string | null;
  declare ip?: string | null;
  declare expiresAt: Date;
  declare replacedBy?: string | null;
  declare revokedAt?: Date | null;
  declare createdAt: Date;
}

OAuthRefreshToken.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    grantId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    tokenHash: {
      type: DataTypes.STRING(64),
      allowNull: false,
      unique: true,
    },
    userAgent: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    ip: {
      type: DataTypes.STRING(45),
      allowNull: true,
    },
    expiresAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    replacedBy: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    revokedAt: {
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
    tableName: 'oauth_refresh_tokens',
    updatedAt: false,
    indexes: [
      { name: 'oauth_refresh_tokens_token_hash', fields: ['tokenHash'], unique: true },
      { name: 'oauth_refresh_tokens_grant_id', fields: ['grantId'] },
    ],
  },
);

export default OAuthRefreshToken;
