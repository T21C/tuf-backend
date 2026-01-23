import {Model, DataTypes, Optional} from 'sequelize';
import LevelSubmission from './LevelSubmission.js';
import Song from '../songs/Song.js';
import { getSequelizeForModelGroup } from '../../config/db.js';
const sequelize = getSequelizeForModelGroup('submissions');

type LevelSubmissionSongRequestAttributes = {
  id: number;
  submissionId: number;
  songId: number | null;
  songName: string | null;
  isNewRequest: boolean;
  requiresEvidence: boolean;
  createdAt: Date;
  updatedAt: Date;
};

type LevelSubmissionSongRequestCreationAttributes = Optional<LevelSubmissionSongRequestAttributes, 'id' | 'createdAt' | 'updatedAt'>;

class LevelSubmissionSongRequest extends Model<LevelSubmissionSongRequestAttributes, LevelSubmissionSongRequestCreationAttributes> {
  declare id: number;
  declare submissionId: number;
  declare songId: number | null;
  declare songName: string | null;
  declare isNewRequest: boolean;
  declare requiresEvidence: boolean;
  declare createdAt: Date;
  declare updatedAt: Date;

  // Associations
  declare submission: LevelSubmission;
  declare song: Song | null;
}

LevelSubmissionSongRequest.init(
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
    songId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'songs',
        key: 'id',
      },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
    },
    songName: {
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
    tableName: 'level_submission_song_requests',
    indexes: [
      {fields: ['submissionId']},
      {fields: ['songId']},
    ],
  },
);

export default LevelSubmissionSongRequest;
