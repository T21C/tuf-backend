import { Model, DataTypes } from 'sequelize';
import { getSequelizeForModelGroup } from '../../config/db.js';
const sequelize = getSequelizeForModelGroup('auth');

interface RateLimitAttributes {
  id?: number;
  ip: string;
  type: string;
  attempts: number;
  blocked?: boolean;
  blockedUntil: Date | null;
  windowStart: Date;
  windowEnd: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type RateLimitCreationAttributes = Omit<RateLimitAttributes, 'id' | 'createdAt' | 'updatedAt'>

class RateLimit extends Model<RateLimitAttributes, RateLimitCreationAttributes> implements RateLimitAttributes {
  declare id?: number;
  declare ip: string;
  declare type: string;
  declare attempts: number;
  declare blocked?: boolean;
  declare blockedUntil: Date | null;
  declare windowStart: Date;
  declare windowEnd: Date;
  declare createdAt: Date;
  declare updatedAt: Date;
}

RateLimit.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    ip: {
      type: DataTypes.STRING(45),
      allowNull: false,
    },
    type: {
      type: DataTypes.STRING(50),
      allowNull: false,
    },
    attempts: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    blocked: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    blockedUntil: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    windowStart: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    windowEnd: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    sequelize,
    tableName: 'rate_limits',
    timestamps: true,
  }
);

export default RateLimit;
