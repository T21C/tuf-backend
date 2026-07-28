import { Model, DataTypes, Optional } from 'sequelize';
import User from './User.js';
import { getSequelizeForModelGroup } from '@/config/db.js';

const sequelize = getSequelizeForModelGroup('auth');

/** Mirrors StepUpScope in StepUpGrantService — kept local to avoid model↔service cycles. */
export type StepUpCodeScope = 'email-change' | 'security';

export interface StepUpCodeAttributes {
  id: string;
  userId: string;
  scope: StepUpCodeScope;
  codeHash: string;
  expiresAt: Date;
  attempts: number;
  consumedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

type StepUpCodeCreationAttributes = Optional<
  StepUpCodeAttributes,
  'id' | 'attempts' | 'consumedAt' | 'createdAt' | 'updatedAt'
>;

class StepUpCode
  extends Model<StepUpCodeAttributes, StepUpCodeCreationAttributes>
  implements StepUpCodeAttributes
{
  declare id: string;
  declare userId: string;
  declare scope: StepUpCodeScope;
  declare codeHash: string;
  declare expiresAt: Date;
  declare attempts: number;
  declare consumedAt: Date | null;
  declare createdAt: Date;
  declare updatedAt: Date;

  declare user?: User;
}

StepUpCode.init(
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
    scope: {
      type: DataTypes.STRING(32),
      allowNull: false,
    },
    codeHash: {
      type: DataTypes.STRING(64),
      allowNull: false,
    },
    expiresAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    attempts: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    consumedAt: {
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
    tableName: 'step_up_codes',
    indexes: [
      { name: 'step_up_codes_user_scope', fields: ['userId', 'scope'] },
      { name: 'step_up_codes_expires', fields: ['expiresAt'] },
    ],
  },
);

export default StepUpCode;
