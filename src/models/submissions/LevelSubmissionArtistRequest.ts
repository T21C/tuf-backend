import {Model, DataTypes, Optional} from 'sequelize';
import LevelSubmission from './LevelSubmission.js';
import Artist from '../artists/Artist.js';
import { getSequelizeForModelGroup } from '../../config/db.js';
const sequelize = getSequelizeForModelGroup('submissions');

type LevelSubmissionArtistRequestAttributes = {
  id: number;
  submissionId: number;
  artistId: number | null;
  artistName: string | null;
  isNewRequest: boolean;
  requiresEvidence: boolean;
  createdAt: Date;
  updatedAt: Date;
};

type LevelSubmissionArtistRequestCreationAttributes = Optional<LevelSubmissionArtistRequestAttributes, 'id' | 'createdAt' | 'updatedAt'>;

class LevelSubmissionArtistRequest extends Model<LevelSubmissionArtistRequestAttributes, LevelSubmissionArtistRequestCreationAttributes> {
  declare id: number;
  declare submissionId: number;
  declare artistId: number | null;
  declare artistName: string | null;
  declare isNewRequest: boolean;
  declare requiresEvidence: boolean;
  declare createdAt: Date;
  declare updatedAt: Date;

  // Associations
  declare submission: LevelSubmission;
  declare artist: Artist | null;
}

LevelSubmissionArtistRequest.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    submissionId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'level_submissions',
        key: 'id',
      },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    },
    artistId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'artists',
        key: 'id',
      },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
    },
    artistName: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    isNewRequest: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    requiresEvidence: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
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
    tableName: 'level_submission_artist_requests',
    indexes: [
      {fields: ['submissionId']},
      {fields: ['artistId']},
    ],
  },
);

export default LevelSubmissionArtistRequest;
