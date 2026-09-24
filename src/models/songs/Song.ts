import {Model, DataTypes, Optional} from 'sequelize';
import { getSequelizeForModelGroup } from '@/config/db.js';
import {
  SONG_VERIFICATION_STATES,
  type SongVerificationState,
} from '@/models/verificationStates.js';

export {
  SONG_VERIFICATION_STATES,
  isSongVerificationState,
  parseSongVerificationState,
} from '@/models/verificationStates.js';
export type { SongVerificationState } from '@/models/verificationStates.js';

const sequelize = getSequelizeForModelGroup('levels');

type SongAttributes = {
  id: number;
  name: string;
  verificationState: SongVerificationState;
  tufVerified: boolean;
  extraInfo: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type SongCreationAttributes = Optional<SongAttributes, 'id' | 'tufVerified' | 'createdAt' | 'updatedAt'>;

class Song extends Model<SongAttributes, SongCreationAttributes> {
  declare id: number;
  declare name: string;
  declare verificationState: SongAttributes['verificationState'];
  declare tufVerified: boolean;
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
    tufVerified: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
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
      {fields: ['tufVerified']},
    ],
  },
);

export default Song;
