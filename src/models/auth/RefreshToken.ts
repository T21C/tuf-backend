import {Model, DataTypes, Optional} from 'sequelize';
import User from './User.js';
import { getSequelizeForModelGroup } from '../../config/db.js';

const sequelize = getSequelizeForModelGroup('auth');

export interface RefreshTokenAttributes {
  id: string;
  userId: string;
  tokenHash: string;
  userAgent?: string | null;
  ip?: string | null;
  label?: string | null;
  expiresAt: Date;
  revokedAt?: Date | null;
  replacedBy?: string | null;
  createdAt: Date;
}

type RefreshTokenCreationAttributes = Optional<
  RefreshTokenAttributes,
  'id' | 'userAgent' | 'ip' | 'label' | 'revokedAt' | 'replacedBy' | 'createdAt'
>;

class RefreshToken
  extends Model<RefreshTokenAttributes, RefreshTokenCreationAttributes>
  implements RefreshTokenAttributes
{
  declare id: string;
  declare userId: string;
  declare tokenHash: string;
  declare userAgent?: string | null;
  declare ip?: string | null;
  declare label?: string | null;
  declare expiresAt: Date;
  declare revokedAt?: Date | null;
  declare replacedBy?: string | null;
  declare createdAt: Date;

  declare user?: User;
}

RefreshToken.init(
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
    label: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    expiresAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    revokedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    replacedBy: {
      type: DataTypes.UUID,
      allowNull: true,
      references: {
        model: 'refresh_tokens',
        key: 'id',
      },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
  },
  {
    sequelize,
    tableName: 'refresh_tokens',
    indexes: [
      { name: 'refresh_tokens_token_hash_revoked_expires', fields: ['tokenHash', 'revokedAt', 'expiresAt'] },
      { name: 'refresh_tokens_user_id', fields: ['userId'] },
    ],
    updatedAt: false,
  },
);

export default RefreshToken;
