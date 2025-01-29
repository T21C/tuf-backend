import {DataTypes} from 'sequelize';
import sequelize from '../config/db.js';
import BaseModel from './BaseModel.js';

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
