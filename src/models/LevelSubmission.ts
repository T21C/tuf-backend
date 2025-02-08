import {DataTypes} from 'sequelize';
import sequelize from '../config/db.js';
import BaseModel from './BaseModel.js';
import LevelSubmissionCreatorRequest from './LevelSubmissionCreatorRequest.js';
import LevelSubmissionTeamRequest from './LevelSubmissionTeamRequest.js';

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
  declare submitterDiscordUsername: string;
  declare submitterDiscordPfp: string;
  declare submitterDiscordId: string;
  declare status: 'pending' | 'approved' | 'declined';
  declare charterId: number | null;
  declare charterRequest: boolean;
  declare vfxerId: number | null;
  declare vfxerRequest: boolean;
  declare teamId: number | null;
  declare teamRequest: boolean;

  // Virtual fields from associations
  declare creatorRequests?: LevelSubmissionCreatorRequest[];
  declare teamRequestData?: LevelSubmissionTeamRequest;

  static associate(models: any) {
    LevelSubmission.hasMany(models.LevelSubmissionCreatorRequest, {
      foreignKey: 'submissionId',
      as: 'creatorRequests'
    });
    LevelSubmission.hasOne(models.LevelSubmissionTeamRequest, {
      foreignKey: 'submissionId',
      as: 'teamRequestData'
    });
  }
}

LevelSubmission.init(
  {
    artist: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    charter: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    diff: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    song: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    team: {
      type: DataTypes.STRING,
      defaultValue: '',
    },
    vfxer: {
      type: DataTypes.STRING,
      defaultValue: '',
    },
    videoLink: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    directDL: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    wsLink: {
      type: DataTypes.STRING,
      defaultValue: '',
    },
    submitterDiscordUsername: {
      type: DataTypes.STRING,
    },
    submitterDiscordPfp: {
      type: DataTypes.STRING,
      defaultValue: '',
    },
    submitterDiscordId: {
      type: DataTypes.STRING,
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
  },
  {
    sequelize,
    tableName: 'level_submissions',
    indexes: [
      {fields: ['charter']},
      {fields: ['artist']},
      {fields: ['status']},
    ],
  },
);

export default LevelSubmission;
