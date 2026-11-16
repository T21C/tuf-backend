import {Model, DataTypes, Optional} from 'sequelize';
import User from './User.js';
import {getSequelizeForModelGroup} from '@/config/db.js';

const sequelize = getSequelizeForModelGroup('auth');

export interface TotpRecoveryCodeAttributes {
  id: string;
  userId: string;
  codeHash: string;
  usedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

type TotpRecoveryCodeCreationAttributes = Optional<
  TotpRecoveryCodeAttributes,
  'id' | 'usedAt' | 'createdAt' | 'updatedAt'
>;

class TotpRecoveryCode
  extends Model<TotpRecoveryCodeAttributes, TotpRecoveryCodeCreationAttributes>
  implements TotpRecoveryCodeAttributes
{
  declare id: string;
  declare userId: string;
  declare codeHash: string;
  declare usedAt: Date | null;
  declare createdAt: Date;
  declare updatedAt: Date;

  declare user?: User;
}

TotpRecoveryCode.init(
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
    codeHash: {
      type: DataTypes.STRING(64),
      allowNull: false,
    },
    usedAt: {
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
    tableName: 'totp_recovery_codes',
    indexes: [
      {name: 'totp_recovery_codes_user_id', fields: ['userId']},
      {
        name: 'totp_recovery_codes_user_id_code_hash',
        fields: ['userId', 'codeHash'],
        unique: true,
      },
    ],
  },
);

export default TotpRecoveryCode;
