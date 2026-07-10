import { DataTypes, Model, Optional } from 'sequelize';
import { getSequelizeForModelGroup } from '@/config/db.js';

const sequelize = getSequelizeForModelGroup('auth');

export const PROFILE_CUSTOMIZATION_UNITS = [
  'banner',
  'header_surface',
  'bio',
  'stellar_icon',
] as const;

export type ProfileCustomizationUnit = (typeof PROFILE_CUSTOMIZATION_UNITS)[number];

export type ProfileCustomizationPayload = Record<string, unknown>;

export interface ProfileCustomizationPieceAttributes {
  id: number;
  userId: string;
  playerId: number | null;
  creatorId: number | null;
  unit: ProfileCustomizationUnit;
  payload: ProfileCustomizationPayload;
  createdAt: Date;
  updatedAt: Date;
}

type ProfileCustomizationPieceCreationAttributes = Optional<
  ProfileCustomizationPieceAttributes,
  'id' | 'createdAt' | 'updatedAt'
>;

class ProfileCustomizationPiece
  extends Model<ProfileCustomizationPieceAttributes, ProfileCustomizationPieceCreationAttributes>
  implements ProfileCustomizationPieceAttributes
{
  declare id: number;
  declare userId: string;
  declare playerId: number | null;
  declare creatorId: number | null;
  declare unit: ProfileCustomizationUnit;
  declare payload: ProfileCustomizationPayload;
  declare createdAt: Date;
  declare updatedAt: Date;
}

ProfileCustomizationPiece.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    playerId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    creatorId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    unit: {
      type: DataTypes.ENUM(...PROFILE_CUSTOMIZATION_UNITS),
      allowNull: false,
    },
    payload: {
      type: DataTypes.JSON,
      allowNull: false,
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
    tableName: 'profile_customization_pieces',
    timestamps: true,
    validate: {
      requireOwnerFk() {
        if (this.playerId == null && this.creatorId == null) {
          throw new Error('Profile customization piece requires playerId or creatorId');
        }
      },
    },
    indexes: [
      { fields: ['userId'], name: 'idx_profile_customization_pieces_user_id' },
      {
        fields: ['playerId', 'unit'],
        unique: true,
        name: 'uniq_profile_customization_pieces_player_unit',
      },
      {
        fields: ['creatorId', 'unit'],
        unique: true,
        name: 'uniq_profile_customization_pieces_creator_unit',
      },
    ],
  },
);

export default ProfileCustomizationPiece;
