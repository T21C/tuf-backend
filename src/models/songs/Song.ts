import {Model, DataTypes, Optional} from 'sequelize';
import { getSequelizeForModelGroup } from '@/config/db.js';
const sequelize = getSequelizeForModelGroup('levels');

export const SONG_VERIFICATION_STATES = [
  'declined',
  'pending',
  'conditional',
  'ysmod_only',
  'allowed',
  'tuf_verified',
] as const;

export type SongVerificationState = (typeof SONG_VERIFICATION_STATES)[number];

const SONG_VERIFICATION_STATE_SET: ReadonlySet<string> = new Set(SONG_VERIFICATION_STATES);

export function isSongVerificationState(value: unknown): value is SongVerificationState {
  return typeof value === 'string' && SONG_VERIFICATION_STATE_SET.has(value);
}

export function parseSongVerificationState(value: unknown): SongVerificationState | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return isSongVerificationState(trimmed) ? trimmed : null;
}

type SongAttributes = {
  id: number;
  name: string;
  verificationState: SongVerificationState;
  extraInfo: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type SongCreationAttributes = Optional<SongAttributes, 'id' | 'createdAt' | 'updatedAt'>;

class Song extends Model<SongAttributes, SongCreationAttributes> {
  declare id: number;
  declare name: string;
  declare verificationState: SongAttributes['verificationState'];
  declare extraInfo: string | null;
  declare createdAt: Date;
  declare updatedAt: Date;

  // Associations
  declare aliases?: import('./SongAlias.js').default[];
  declare links?: import('./SongLink.js').default[];
  declare evidences?: import('./SongEvidence.js').default[];
  declare credits?: import('./SongCredit.js').default[];
  declare artists?: import('../artists/Artist.js').default[];
  declare levels?: import('../levels/Level.js').default[];
}

Song.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    name: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    verificationState: {
      type: DataTypes.ENUM(...SONG_VERIFICATION_STATES),
      allowNull: false,
      defaultValue: 'pending',
    },
    extraInfo: {
      type: DataTypes.TEXT,
      allowNull: true,
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
    tableName: 'songs',
    indexes: [
      {fields: ['name']},
      {fields: ['verificationState']},
    ],
  },
);

export default Song;
