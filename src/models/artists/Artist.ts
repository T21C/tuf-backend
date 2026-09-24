import {Model, DataTypes, Optional} from 'sequelize';
import { getSequelizeForModelGroup } from '@/config/db.js';
import {
  ARTIST_VERIFICATION_STATES,
  type ArtistVerificationState,
} from '@/models/verificationStates.js';

export {
  ARTIST_VERIFICATION_STATES,
  isArtistVerificationState,
  parseArtistVerificationState,
} from '@/models/verificationStates.js';
export type { ArtistVerificationState } from '@/models/verificationStates.js';

const sequelize = getSequelizeForModelGroup('levels');

type ArtistAttributes = {
  id: number;
  name: string;
  avatarUrl: string | null;
  verificationState: ArtistVerificationState;
  tufVerified: boolean;
  extraInfo: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type ArtistCreationAttributes = Optional<ArtistAttributes, 'id' | 'tufVerified' | 'createdAt' | 'updatedAt'>;

class Artist extends Model<ArtistAttributes, ArtistCreationAttributes> {
  declare id: number;
  declare name: string;
  declare avatarUrl: string | null;
  declare verificationState: ArtistAttributes['verificationState'];
  declare tufVerified: boolean;
  declare extraInfo: string | null;
  declare createdAt: Date;
  declare updatedAt: Date;

  // Associations
  declare aliases?: import('./ArtistAlias.js').default[];
  declare links?: import('./ArtistLink.js').default[];
  declare evidences?: import('./ArtistEvidence.js').default[];
  declare songCredits?: import('../songs/SongCredit.js').default[];
  declare songs?: import('../songs/Song.js').default[];
  declare levels?: import('../levels/Level.js').default[];
  declare relatedArtists?: import('./Artist.js').default[];
}

Artist.init(
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
    avatarUrl: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    verificationState: {
      type: DataTypes.ENUM(...ARTIST_VERIFICATION_STATES),
      allowNull: false,
      defaultValue: 'unverified',
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
    tableName: 'artists',
    indexes: [
      {fields: ['name']},
      {fields: ['verificationState']},
      {fields: ['tufVerified']},
    ],
  },
);

export default Artist;
