import { Model, DataTypes, Optional } from 'sequelize';
import { getSequelizeForModelGroup } from '@/config/db.js';

const sequelize = getSequelizeForModelGroup('auth');

export interface OAuthGrantAttributes {
  id: string;
  userId: string;
  clientId: string;
  scopeBits: string;
  singleGrant: boolean;
  revokedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

type OAuthGrantCreationAttributes = Optional<
  OAuthGrantAttributes,
  'id' | 'singleGrant' | 'revokedAt' | 'createdAt' | 'updatedAt'
>;

class OAuthGrant
  extends Model<OAuthGrantAttributes, OAuthGrantCreationAttributes>
  implements OAuthGrantAttributes
{
  declare id: string;
  declare userId: string;
  declare clientId: string;
  declare scopeBits: string;
  declare singleGrant: boolean;
  declare revokedAt?: Date | null;
  declare createdAt: Date;
  declare updatedAt: Date;
}

OAuthGrant.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    clientId: {
      type: DataTypes.STRING(64),
      allowNull: false,
    },
    scopeBits: {
      type: DataTypes.STRING(64),
      allowNull: false,
      defaultValue: '0',
    },
    singleGrant: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    revokedAt: {
      type: DataTypes.DATE,
      allowNull: true,
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
    tableName: 'oauth_grants',
    indexes: [
      { name: 'oauth_grants_user_client', fields: ['userId', 'clientId'] },
      { name: 'oauth_grants_client_id', fields: ['clientId'] },
    ],
  },
);

export default OAuthGrant;
