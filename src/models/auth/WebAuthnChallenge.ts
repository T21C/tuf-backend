import { Model, DataTypes, Optional } from 'sequelize';
import { getSequelizeForModelGroup } from '@/config/db.js';

const sequelize = getSequelizeForModelGroup('auth');

export type WebAuthnChallengeType = 'registration' | 'authentication';

export interface WebAuthnChallengeAttributes {
  id: string;
  challenge: string;
  type: WebAuthnChallengeType;
  userId: string | null;
  expiresAt: Date;
  createdAt: Date;
}

type WebAuthnChallengeCreationAttributes = Optional<
  WebAuthnChallengeAttributes,
  'id' | 'userId' | 'createdAt'
>;

class WebAuthnChallenge
  extends Model<WebAuthnChallengeAttributes, WebAuthnChallengeCreationAttributes>
  implements WebAuthnChallengeAttributes
{
  declare id: string;
  declare challenge: string;
  declare type: WebAuthnChallengeType;
  declare userId: string | null;
  declare expiresAt: Date;
  declare createdAt: Date;
}

WebAuthnChallenge.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    challenge: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    type: {
      type: DataTypes.ENUM('registration', 'authentication'),
      allowNull: false,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: true,
      defaultValue: null,
      references: {
        model: 'users',
        key: 'id',
      },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    expiresAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
  },
  {
    sequelize,
    tableName: 'webauthn_challenges',
    updatedAt: false,
    indexes: [
      { name: 'webauthn_challenges_challenge', fields: ['challenge'], unique: true },
      { name: 'webauthn_challenges_expires', fields: ['expiresAt'] },
      { name: 'webauthn_challenges_user_id', fields: ['userId'] },
    ],
  },
);

export default WebAuthnChallenge;
