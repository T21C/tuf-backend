import {DataTypes} from 'sequelize';
import BaseModel from '../BaseModel.js';
import LevelSubmissionCreatorRequest from './LevelSubmissionCreatorRequest.js';
import LevelSubmissionTeamRequest from './LevelSubmissionTeamRequest.js';
import LevelSubmissionSongRequest from './LevelSubmissionSongRequest.js';
import LevelSubmissionArtistRequest from './LevelSubmissionArtistRequest.js';
import LevelSubmissionEvidence from './LevelSubmissionEvidence.js';
import User from '../auth/User.js';
import Song from '../songs/Song.js';
import Artist from '../artists/Artist.js';
import { getSequelizeForModelGroup } from '../../config/db.js';
const sequelize = getSequelizeForModelGroup('submissions');

class LevelSubmission extends BaseModel {
  declare artist: string;
  declare charter: string;
  declare diff: string;
  declare song: string;
  declare team: string;
  declare vfxer: string;
  declare videoLink: string;
  declare directDL: string;
  declare wsLink: string;
  declare submitterId: string;
  declare status: 'pending' | 'approved' | 'declined';
  declare charterId: number | null;
  declare charterRequest: boolean;
  declare vfxerId: number | null;
  declare vfxerRequest: boolean;
  declare teamId: number | null;
  declare teamRequest: boolean;
  declare userId: string | null;
  declare songId: number | null;
  declare artistId: number | null;
  declare songRequestId: number | null;
  declare artistRequestId: number | null;

  // Virtual fields from associations
  declare creatorRequests?: LevelSubmissionCreatorRequest[];
  declare teamRequestData?: LevelSubmissionTeamRequest;
  declare levelSubmitter?: User;
  declare songRequest?: LevelSubmissionSongRequest;
  declare artistRequests?: LevelSubmissionArtistRequest[];
  declare evidence?: LevelSubmissionEvidence[];
  declare songObject?: Song;
  declare artistObject?: Artist;
}

LevelSubmission.init(
  {
    artist: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    charter: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    diff: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    song: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    team: {
      type: DataTypes.TEXT,
      defaultValue: '',
    },
    vfxer: {
      type: DataTypes.TEXT,
      defaultValue: '',
    },
    videoLink: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    directDL: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    wsLink: {
      type: DataTypes.TEXT,
      defaultValue: '',
    },
    status: {
      type: DataTypes.ENUM('pending', 'approved', 'declined'),
      defaultValue: 'pending',
    },
    charterId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'creators',
        key: 'id',
      },
    },
    charterRequest: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    vfxerId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'creators',
        key: 'id',
      },
    },
    vfxerRequest: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    teamId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'teams',
        key: 'id',
      },
    },
    teamRequest: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: true,
      references: {
        model: 'users',
        key: 'id',
      },
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
    songRequestId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'level_submission_song_requests',
        key: 'id',
      },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
    },
    artistRequestId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'level_submission_artist_requests',
        key: 'id',
      },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
    },
  },
  {
    sequelize,
    tableName: 'level_submissions',
    indexes: [
      {fields: ['charter']},
      {fields: ['artist']},
      {fields: ['status']},
      {fields: ['userId']},
      {fields: ['songId']},
      {fields: ['artistId']},
      {fields: ['songRequestId']},
      {fields: ['artistRequestId']},
    ],
  },
);

export default LevelSubmission;
