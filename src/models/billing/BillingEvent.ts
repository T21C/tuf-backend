import { DataTypes, Model, Optional } from 'sequelize';
import { getSequelizeForModelGroup } from '@/config/db.js';

const sequelize = getSequelizeForModelGroup('auth');

export type BillingEventStatus = 'received' | 'processed' | 'ignored' | 'failed' | 'refunded';

export interface BillingEventAttributes {
  id: number;
  provider: string;
  eventType: string;
  idempotencyKey: string;
  status: BillingEventStatus;
  userId: string | null;
  /** Gift beneficiary internal UUID (custom_parameters); indexed for recipient activity queries. */
  beneficiaryUserId: string | null;
  xsollaTransactionId: number | null;
  xsollaSubscriptionId: number | null;
  externalId: string | null;
  rawBody: string;
  rawBodySha256: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  processedAt: Date | null;
  failedAt: Date | null;
}

type BillingEventCreation = Optional<
  BillingEventAttributes,
  | 'id'
  | 'status'
  | 'userId'
  | 'beneficiaryUserId'
  | 'xsollaTransactionId'
  | 'xsollaSubscriptionId'
  | 'externalId'
  | 'rawBodySha256'
  | 'errorCode'
  | 'errorMessage'
  | 'createdAt'
  | 'processedAt'
  | 'failedAt'
>;

class BillingEvent extends Model<BillingEventAttributes, BillingEventCreation> implements BillingEventAttributes {
  declare id: number;
  declare provider: string;
  declare eventType: string;
  declare idempotencyKey: string;
  declare status: BillingEventStatus;
  declare userId: string | null;
  declare beneficiaryUserId: string | null;
  declare xsollaTransactionId: number | null;
  declare xsollaSubscriptionId: number | null;
  declare externalId: string | null;
  declare rawBody: string;
  declare rawBodySha256: string | null;
  declare errorCode: string | null;
  declare errorMessage: string | null;
  declare createdAt: Date;
  declare processedAt: Date | null;
  declare failedAt: Date | null;
}

BillingEvent.init(
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    provider: {
      type: DataTypes.STRING(32),
      allowNull: false,
    },
    eventType: {
      type: DataTypes.STRING(64),
      allowNull: false,
    },
    idempotencyKey: {
      type: DataTypes.STRING(191),
      allowNull: false,
    },
    status: {
      type: DataTypes.ENUM('received', 'processed', 'ignored', 'failed', 'refunded'),
      allowNull: false,
      defaultValue: 'received',
    },
    userId: {
      type: DataTypes.STRING(64),
      allowNull: true,
    },
    beneficiaryUserId: {
      type: DataTypes.STRING(36),
      allowNull: true,
    },
    xsollaTransactionId: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: true,
    },
    xsollaSubscriptionId: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: true,
    },
    externalId: {
      type: DataTypes.STRING(128),
      allowNull: true,
    },
    rawBody: {
      type: DataTypes.TEXT('medium'),
      allowNull: false,
    },
    rawBodySha256: {
      type: DataTypes.STRING(64),
      allowNull: true,
    },
    errorCode: {
      type: DataTypes.STRING(64),
      allowNull: true,
    },
    errorMessage: {
      type: DataTypes.STRING(512),
      allowNull: true,
    },
    createdAt: {
      type: DataTypes.DATE(6),
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    processedAt: {
      type: DataTypes.DATE(6),
      allowNull: true,
    },
    failedAt: {
      type: DataTypes.DATE(6),
      allowNull: true,
    },
  },
  {
    sequelize,
    modelName: 'BillingEvent',
    tableName: 'billing_events',
    timestamps: false,
    underscored: true,
    indexes: [
      { unique: true, fields: ['provider', 'idempotency_key'], name: 'uniq_billing_events_provider_idempotency' },
      { fields: ['user_id', 'created_at'], name: 'idx_billing_events_user_created_at' },
      { fields: ['xsolla_subscription_id', 'created_at'], name: 'idx_billing_events_xsolla_subscription_created_at' },
      { fields: ['xsolla_transaction_id', 'created_at'], name: 'idx_billing_events_xsolla_transaction_created_at' },
      { fields: ['status', 'created_at', 'id'], name: 'idx_billing_events_status_created_at' },
    ],
  },
);

export default BillingEvent;

