import { DataTypes, Model, Optional } from 'sequelize';
import { getSequelizeForModelGroup } from '@/config/db.js';

const sequelize = getSequelizeForModelGroup('auth');

export type TufStellarEntitlementSegmentKind = 'gift' | 'subscription';

export interface UserTufStellarEntitlementSegmentAttributes {
  id: number;
  userId: string;
  kind: TufStellarEntitlementSegmentKind;
  months: number;
  startsAt: Date;
  endsAt: Date;
  idempotencyKey: string;
  xsollaTransactionId?: number | null;
  xsollaSubscriptionId?: number | null;
  billingEventId?: number | null;
  createdAt: Date;
}

type Creation = Optional<
  UserTufStellarEntitlementSegmentAttributes,
  'id' | 'xsollaTransactionId' | 'xsollaSubscriptionId' | 'billingEventId' | 'createdAt'
>;

class UserTufStellarEntitlementSegment
  extends Model<UserTufStellarEntitlementSegmentAttributes, Creation>
  implements UserTufStellarEntitlementSegmentAttributes
{
  declare id: number;
  declare userId: string;
  declare kind: TufStellarEntitlementSegmentKind;
  declare months: number;
  declare startsAt: Date;
  declare endsAt: Date;
  declare idempotencyKey: string;
  declare xsollaTransactionId?: number | null;
  declare xsollaSubscriptionId?: number | null;
  declare billingEventId?: number | null;
  declare createdAt: Date;
}

UserTufStellarEntitlementSegment.init(
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'users', key: 'id' },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    },
    kind: {
      type: DataTypes.STRING(16),
      allowNull: false,
    },
    months: {
      type: DataTypes.TINYINT.UNSIGNED,
      allowNull: false,
    },
    startsAt: {
      type: DataTypes.DATE(6),
      allowNull: false,
    },
    endsAt: {
      type: DataTypes.DATE(6),
      allowNull: false,
    },
    idempotencyKey: {
      type: DataTypes.STRING(191),
      allowNull: false,
      unique: true,
    },
    xsollaTransactionId: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: true,
      defaultValue: null,
    },
    xsollaSubscriptionId: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: true,
      defaultValue: null,
    },
    billingEventId: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: true,
      defaultValue: null,
      references: { model: 'billing_events', key: 'id' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
    },
    createdAt: {
      type: DataTypes.DATE(6),
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    sequelize,
    modelName: 'UserTufStellarEntitlementSegment',
    tableName: 'user_tuf_stellar_entitlement_segments',
    timestamps: false,
    underscored: false,
    indexes: [
      { fields: ['userId'], name: 'idx_tuf_stellar_entitlement_segments_user' },
      { fields: ['userId', 'endsAt'], name: 'idx_tuf_stellar_entitlement_segments_user_ends' },
    ],
  },
);

export default UserTufStellarEntitlementSegment;
