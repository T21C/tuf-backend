import {DataTypes, Model, Optional} from 'sequelize';
import User from '@/models/auth/User.js';
import {getSequelizeForModelGroup} from '@/config/db.js';

const sequelize = getSequelizeForModelGroup('notifications');

export const PROFILE_NOTE_TARGET_TYPES = ['player', 'creator'] as const;
export type ProfileNoteTargetType = (typeof PROFILE_NOTE_TARGET_TYPES)[number];

export const PROFILE_NOTE_MAX_LENGTH = 2000;

export interface ProfileNoteAttributes {
  id: number;
  userId: string;
  targetType: ProfileNoteTargetType;
  targetId: number;
  text: string;
  createdAt: Date;
  updatedAt: Date;
}

type ProfileNoteCreationAttributes = Optional<
  ProfileNoteAttributes,
  'id' | 'createdAt' | 'updatedAt'
>;

class ProfileNote
  extends Model<ProfileNoteAttributes, ProfileNoteCreationAttributes>
  implements ProfileNoteAttributes
{
  declare id: number;
  declare userId: string;
  declare targetType: ProfileNoteTargetType;
  declare targetId: number;
  declare text: string;
  declare createdAt: Date;
  declare updatedAt: Date;

  declare user?: User;
}

ProfileNote.init(
  {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {model: 'users', key: 'id'},
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    targetType: {
      type: DataTypes.ENUM(...PROFILE_NOTE_TARGET_TYPES),
      allowNull: false,
    },
    targetId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    text: {
      type: DataTypes.STRING(PROFILE_NOTE_MAX_LENGTH),
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
    tableName: 'profile_notes',
    timestamps: true,
    indexes: [
      {
        name: 'profile_notes_user_id_target_type_target_id',
        unique: true,
        fields: ['userId', 'targetType', 'targetId'],
      },
    ],
  },
);

export default ProfileNote;
