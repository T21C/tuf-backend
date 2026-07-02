import { DataTypes, Model, Optional } from 'sequelize';
import { getSequelizeForModelGroup } from '@/config/db.js';

const sequelize = getSequelizeForModelGroup('auth');

export type TufStellarAdminGrantDurationKind = 'months' | 'days';
export type TufStellarAdminGrantStatus = 'active' | 'retracted';

export interface UserTufStellarAdminGrantAttributes {
  id: number;
  grantedByUserId: string;
  beneficiaryUserId: string;
  durationKind: TufStellarAdminGrantDurationKind;
  durationValue: number;
  startsAt: Date;
  endsAt: Date;
  segmentId?: number | null;
  note?: string | null;
  status: TufStellarAdminGrantStatus;
  retractedByUserId?: string | null;
  retractedAt?: Date | null;
  createdAt: Date;
}

type Creation = Optional<
  UserTufStellarAdminGrantAttributes,
  'id' | 'segmentId' | 'note' | 'status' | 'retractedByUserId' | 'retractedAt' | 'createdAt'
>;

class UserTufStellarAdminGrant
  extends Model<UserTufStellarAdminGrantAttributes, Creation>
  implements UserTufStellarAdminGrantAttributes
{
  declare id: number;
  declare grantedByUserId: string;
  declare beneficiaryUserId: string;
  declare durationKind: TufStellarAdminGrantDurationKind;
  declare durationValue: number;
  declare startsAt: Date;
  declare endsAt: Date;
  declare segmentId?: number | null;
  declare note?: string | null;
  declare status: TufStellarAdminGrantStatus;
  declare retractedByUserId?: string | null;
  declare retractedAt?: Date | null;
  declare createdAt: Date;
}

UserTufStellarAdminGrant.init(
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    grantedByUserId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'users', key: 'id' },
    },
    beneficiaryUserId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'users', key: 'id' },
    },
    durationKind: {
      type: DataTypes.ENUM('months', 'days'),
      allowNull: false,
    },
    durationValue: {
      type: DataTypes.INTEGER.UNSIGNED,
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
    segmentId: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: true,
      defaultValue: null,
      references: { model: 'user_tuf_stellar_entitlement_segments', key: 'id' },
    },
    note: {
      type: DataTypes.STRING(255),
      allowNull: true,
      defaultValue: null,
    },
    status: {
      type: DataTypes.ENUM('active', 'retracted'),
      allowNull: false,
      defaultValue: 'active',
    },
    retractedByUserId: {
      type: DataTypes.UUID,
      allowNull: true,
      defaultValue: null,
      references: { model: 'users', key: 'id' },
    },
    retractedAt: {
      type: DataTypes.DATE(6),
      allowNull: true,
      defaultValue: null,
    },
    createdAt: {
      type: DataTypes.DATE(6),
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    sequelize,
    modelName: 'UserTufStellarAdminGrant',
    tableName: 'tuf_stellar_admin_grants',
    timestamps: false,
    underscored: false,
    indexes: [
      { fields: ['beneficiaryUserId'], name: 'idx_tuf_stellar_admin_grants_beneficiary' },
      { fields: ['grantedByUserId'], name: 'idx_tuf_stellar_admin_grants_granted_by' },
      { fields: ['endsAt'], name: 'idx_tuf_stellar_admin_grants_ends_at' },
      { fields: ['createdAt'], name: 'idx_tuf_stellar_admin_grants_created_at' },
    ],
  },
);

export default UserTufStellarAdminGrant;
