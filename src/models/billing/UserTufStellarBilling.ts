import { DataTypes, Model, Optional } from 'sequelize';
import { getSequelizeForModelGroup } from '@/config/db.js';

const sequelize = getSequelizeForModelGroup('auth');

export type TufStellarBillingLifecycleColumn =
  | 'inactive'
  | 'active_checkout_pending'
  | 'active_renewing'
  | 'active_cancelling';

export interface UserTufStellarBillingAttributes {
  userId: string;
  tufStellarSubscriptionExpiresAt?: Date | null;
  tufStellarSubscriptionExternalId?: string | null;
  tufStellarSubscriptionPlanExternalId?: string | null;
  tufStellarSubscriptionCancelledAt?: Date | null;
  tufStellarBillingLifecycleState: TufStellarBillingLifecycleColumn;
  tufStellarPendingAutoRenew?: boolean | null;
  tufStellarPendingGiftBeneficiaryUserId?: string | null;
  tufStellarPendingGiftMonths?: number | null;
  tufStellarRecurringPeriodEndAt?: Date | null;
  /**
   * End of the current subscription billing cycle from the last Xsolla webhook (`date_next_charge` / period),
   * before billing sync shifts `tufStellarRecurringPeriodEndAt` to align with stacked access.
   */
  tufStellarSubscriptionNominalPeriodEndAt?: Date | null;
  tufStellarXsollaBillingSyncAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

type Creation = Optional<
  UserTufStellarBillingAttributes,
  | 'tufStellarSubscriptionExpiresAt'
  | 'tufStellarSubscriptionExternalId'
  | 'tufStellarSubscriptionPlanExternalId'
  | 'tufStellarSubscriptionCancelledAt'
  | 'tufStellarPendingAutoRenew'
  | 'tufStellarPendingGiftBeneficiaryUserId'
  | 'tufStellarPendingGiftMonths'
  | 'tufStellarRecurringPeriodEndAt'
  | 'tufStellarSubscriptionNominalPeriodEndAt'
  | 'tufStellarXsollaBillingSyncAt'
  | 'createdAt'
  | 'updatedAt'
> &
  Partial<Pick<UserTufStellarBillingAttributes, 'tufStellarBillingLifecycleState'>>;

class UserTufStellarBilling
  extends Model<UserTufStellarBillingAttributes, Creation>
  implements UserTufStellarBillingAttributes
{
  declare userId: string;
  declare tufStellarSubscriptionExpiresAt?: Date | null;
  declare tufStellarSubscriptionExternalId?: string | null;
  declare tufStellarSubscriptionPlanExternalId?: string | null;
  declare tufStellarSubscriptionCancelledAt?: Date | null;
  declare tufStellarBillingLifecycleState: TufStellarBillingLifecycleColumn;
  declare tufStellarPendingAutoRenew?: boolean | null;
  declare tufStellarPendingGiftBeneficiaryUserId?: string | null;
  declare tufStellarPendingGiftMonths?: number | null;
  declare tufStellarRecurringPeriodEndAt?: Date | null;
  declare tufStellarSubscriptionNominalPeriodEndAt?: Date | null;
  declare tufStellarXsollaBillingSyncAt?: Date | null;
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
    tufStellarSubscriptionExternalId: {
      type: DataTypes.STRING(191),
      allowNull: true,
      defaultValue: null,
    },
    tufStellarSubscriptionPlanExternalId: {
      type: DataTypes.STRING(64),
      allowNull: true,
      defaultValue: null,
    },
    tufStellarSubscriptionCancelledAt: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: null,
    },
    tufStellarBillingLifecycleState: {
      type: DataTypes.STRING(32),
      allowNull: false,
      defaultValue: 'inactive',
    },
    tufStellarPendingAutoRenew: {
      type: DataTypes.BOOLEAN,
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
    tufStellarRecurringPeriodEndAt: {
      type: DataTypes.DATE(6),
      allowNull: true,
      defaultValue: null,
    },
    tufStellarSubscriptionNominalPeriodEndAt: {
      type: DataTypes.DATE(6),
      allowNull: true,
      defaultValue: null,
    },
    tufStellarXsollaBillingSyncAt: {
      type: DataTypes.DATE(6),
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
