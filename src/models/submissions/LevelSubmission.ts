import {DataTypes} from 'sequelize';
import BaseModel from '../BaseModel.js';
import LevelSubmissionCreatorRequest from './LevelSubmissionCreatorRequest.js';
import LevelSubmissionTeamRequest from './LevelSubmissionTeamRequest.js';
import User from '../auth/User.js';
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

  // Virtual fields from associations
  declare creatorRequests?: LevelSubmissionCreatorRequest[];
  declare teamRequestData?: LevelSubmissionTeamRequest;
  declare levelSubmitter?: User;
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
  },
  {
    sequelize,
    tableName: 'level_submissions',
    indexes: [
      {fields: ['charter']},
      {fields: ['artist']},
      {fields: ['status']},
      {fields: ['userId']},
    ],
  },
);

export default LevelSubmission;
