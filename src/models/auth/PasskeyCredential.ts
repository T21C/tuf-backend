import { Model, DataTypes, Optional } from 'sequelize';
import User from './User.js';
import { getSequelizeForModelGroup } from '@/config/db.js';

const sequelize = getSequelizeForModelGroup('auth');

export interface PasskeyCredentialAttributes {
  id: string;
  userId: string;
  credentialId: string;
  publicKey: Buffer;
  signCount: number;
  transports: string | null;
  deviceType: string | null;
  backedUp: boolean;
  name: string;
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

type PasskeyCredentialCreationAttributes = Optional<
  PasskeyCredentialAttributes,
  | 'id'
  | 'transports'
  | 'deviceType'
  | 'backedUp'
  | 'lastUsedAt'
  | 'createdAt'
  | 'updatedAt'
>;

class PasskeyCredential
  extends Model<PasskeyCredentialAttributes, PasskeyCredentialCreationAttributes>
  implements PasskeyCredentialAttributes
{
  declare id: string;
  declare userId: string;
  declare credentialId: string;
  declare publicKey: Buffer;
  declare signCount: number;
  declare transports: string | null;
  declare deviceType: string | null;
  declare backedUp: boolean;
  declare name: string;
  declare lastUsedAt: Date | null;
  declare createdAt: Date;
  declare updatedAt: Date;

  declare user?: User;
}

PasskeyCredential.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
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
    credentialId: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    publicKey: {
      type: DataTypes.BLOB,
      allowNull: false,
    },
    signCount: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
    },
    transports: {
      type: DataTypes.STRING(255),
      allowNull: true,
      defaultValue: null,
    },
    deviceType: {
      type: DataTypes.STRING(32),
      allowNull: true,
      defaultValue: null,
    },
    backedUp: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    name: {
      type: DataTypes.STRING(64),
      allowNull: false,
    },
    lastUsedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: null,
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
    tableName: 'passkey_credentials',
    indexes: [
      { name: 'passkey_credentials_credential_id', fields: ['credentialId'], unique: true },
      { name: 'passkey_credentials_user_id', fields: ['userId'] },
    ],
  },
);

export default PasskeyCredential;
