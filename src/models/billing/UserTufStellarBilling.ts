import { DataTypes, Model, Optional } from 'sequelize';
import { getSequelizeForModelGroup } from '@/config/db.js';

const sequelize = getSequelizeForModelGroup('auth');

export interface UserTufStellarBillingAttributes {
  userId: string;
  /** Materialized max(end) of purchase entitlement segments (legacy column name). */
  tufStellarSubscriptionExpiresAt?: Date | null;
  tufStellarPendingGiftBeneficiaryUserId?: string | null;
  tufStellarPendingGiftMonths?: number | null;
  createdAt: Date;
  updatedAt: Date;
}

type Creation = Optional<
  UserTufStellarBillingAttributes,
  | 'tufStellarSubscriptionExpiresAt'
  | 'tufStellarPendingGiftBeneficiaryUserId'
  | 'tufStellarPendingGiftMonths'
  | 'createdAt'
  | 'updatedAt'
>;

class UserTufStellarBilling
  extends Model<UserTufStellarBillingAttributes, Creation>
  implements UserTufStellarBillingAttributes
{
  declare userId: string;
  declare tufStellarSubscriptionExpiresAt?: Date | null;
  declare tufStellarPendingGiftBeneficiaryUserId?: string | null;
  declare tufStellarPendingGiftMonths?: number | null;
  declare createdAt: Date;
  declare updatedAt: Date;
}

UserTufStellarBilling.init(
  {
    userId: {
      type: DataTypes.UUID,
      primaryKey: true,
      allowNull: false,
      references: { model: 'users', key: 'id' },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    },
    tufStellarSubscriptionExpiresAt: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: null,
    },
    tufStellarPendingGiftBeneficiaryUserId: {
      type: DataTypes.STRING(36),
      allowNull: true,
      defaultValue: null,
    },
    tufStellarPendingGiftMonths: {
      type: DataTypes.TINYINT.UNSIGNED,
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
    modelName: 'UserTufStellarBilling',
    tableName: 'user_tuf_stellar_billing',
    timestamps: true,
    underscored: false,
  },
);

export default UserTufStellarBilling;
