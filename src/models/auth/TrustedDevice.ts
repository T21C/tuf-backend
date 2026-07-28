import { Model, DataTypes, Optional } from 'sequelize';
import User from './User.js';
import { getSequelizeForModelGroup } from '@/config/db.js';

const sequelize = getSequelizeForModelGroup('auth');

export interface TrustedDeviceAttributes {
  id: string;
  userId: string;
  tokenHash: string;
  userAgent: string | null;
  ip: string | null;
  lastUsedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

type TrustedDeviceCreationAttributes = Optional<
  TrustedDeviceAttributes,
  'id' | 'userAgent' | 'ip' | 'revokedAt' | 'createdAt' | 'updatedAt'
>;

class TrustedDevice
  extends Model<TrustedDeviceAttributes, TrustedDeviceCreationAttributes>
  implements TrustedDeviceAttributes
{
  declare id: string;
  declare userId: string;
  declare tokenHash: string;
  declare userAgent: string | null;
  declare ip: string | null;
  declare lastUsedAt: Date;
  declare expiresAt: Date;
  declare revokedAt: Date | null;
  declare createdAt: Date;
  declare updatedAt: Date;

  declare user?: User;
}

TrustedDevice.init(
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
    tokenHash: {
      type: DataTypes.STRING(64),
      allowNull: false,
    },
    userAgent: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    ip: {
      type: DataTypes.STRING(45),
      allowNull: true,
    },
    lastUsedAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    expiresAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    revokedAt: {
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
    tableName: 'trusted_devices',
    indexes: [
      { name: 'trusted_devices_token_hash', fields: ['tokenHash'], unique: true },
      { name: 'trusted_devices_user_id', fields: ['userId'] },
      { name: 'trusted_devices_expires', fields: ['expiresAt'] },
    ],
  },
);

export default TrustedDevice;
