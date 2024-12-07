import { DataTypes } from 'sequelize';
import sequelize from '../config/db';
import BaseModel from './BaseModel';

class ChartSubmission extends BaseModel {
  public artist!: string;
  public charter!: string;
  public diff!: string;
  public song!: string;
  public team!: string;
  public vfxer!: string;
  public videoLink!: string;
  public directDL!: string;
  public wsLink!: string;
  public submitterDiscordUsername!: string;
  public submitterEmail!: string;
  public status!: 'pending' | 'approved' | 'declined';
  public toRate!: boolean;
}

ChartSubmission.init({
  artist: {
    type: DataTypes.STRING,
    allowNull: false
  },
  charter: {
    type: DataTypes.STRING,
    allowNull: false
  },
  diff: {
    type: DataTypes.STRING,
    allowNull: false
  },
  song: {
    type: DataTypes.STRING,
    allowNull: false
  },
  team: {
    type: DataTypes.STRING,
    defaultValue: ''
  },
  vfxer: {
    type: DataTypes.STRING,
    defaultValue: ''
  },
  videoLink: {
    type: DataTypes.STRING,
    allowNull: false
  },
  directDL: {
    type: DataTypes.STRING,
    allowNull: false
  },
  wsLink: {
    type: DataTypes.STRING,
    defaultValue: ''
  },
  submitterDiscordUsername: {
    type: DataTypes.STRING
  },
  submitterEmail: {
    type: DataTypes.STRING
  },
  status: {
    type: DataTypes.ENUM('pending', 'approved', 'declined'),
    defaultValue: 'pending'
  },
  toRate: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  }
}, {
  sequelize,
  tableName: 'chart_submissions',
  indexes: [
    { fields: ['charter'] },
    { fields: ['artist'] },
    { fields: ['status'] }
  ]
});

export default ChartSubmission;